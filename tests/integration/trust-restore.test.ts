import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * `POST /users/:id/restore-trust` — master trả bậc uy tín về trần.
 *
 * Tồn tại vì bậc chỉ leo lại bằng 5 tin liên tiếp do NGƯỜI duyệt thông qua, mà máy duyệt (không
 * cộng điểm) xử gần hết tin của người bậc thấp sau khi án 7 ngày trôi qua: một lượt gỡ nhầm là
 * mất bậc vĩnh viễn. Đối xứng với `clear-rejections`, và hai lệnh KHÔNG được gộp: một cái trả
 * bậc, cái kia gỡ án 7 ngày.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let categoryId = ''
const ORG = 'nhom-restore'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

const levelOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  const { INITIAL_TRUST } = await import('../../src/features/trust/trust.policy')
  return (await UserTrust.findOne({ userId }).lean().exec())?.level ?? INITIAL_TRUST.level
}

async function newMember() {
  seq += 1
  const u = await registerUser(app, `seller-${seq}@restore.local`, `Người bán ${seq}`)
  await addMember(u.id, orgIdOf(ORG))
  return u
}

async function postInternal(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

/** Hạ bậc bằng đúng đường thật: gỡ một tin đã lên bảng ở bàn duyệt. */
async function penalize(seller: TestUser) {
  const l = await postInternal(seller)
  expect(l.status).toBe('active')
  await request(app)
    .delete(`/api/v1/moderation/listings/${l._id}`)
    .set(orgAuth(owner.token, ORG))
    .send({ reason: 'Nghi hàng giả' })
    .expect(200)
  expect(await levelOf(seller.id)).toBe(1)
}

const restore = (who: TestUser, userId: string, body: object) =>
  request(app).post(`/api/v1/users/${userId}/restore-trust`).set(bearer(who)).send(body)

const quotaOf = async (who: TestUser) =>
  (await request(app).get('/api/v1/listings/quota').set(bearer(who)).expect(200)).body.data

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-restore')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@restore.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm Restore', key: ORG, ownerEmail: owner.email })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Phục hồi uy tín', () => {
  it('master trả bậc cho người bị gỡ nhầm → bậc 2, tự đăng lại được, có thông báo kèm lý do', async () => {
    const seller = await newMember()
    await penalize(seller)
    expect((await quotaOf(seller)).standing.canSelfPublish).toBe(false)

    const res = await restore(master, seller.id, { reason: 'Gỡ nhầm, đã xác minh' }).expect(200)
    expect(res.body.data.trustLevel).toBe(2)
    expect(await levelOf(seller.id)).toBe(2)
    expect((await quotaOf(seller)).standing.canSelfPublish).toBe(true)

    // Tin kế tiếp lên bảng ngay — đúng thứ người bị oan cần.
    expect((await postInternal(seller)).status).toBe('active')

    const inbox = await request(app).get('/api/v1/notifications').set(bearer(seller)).expect(200)
    const note = inbox.body.data.find(
      (n: { title: string }) => n.title === 'Uy tín của bạn đã được phục hồi',
    )
    expect(note?.body).toContain('Gỡ nhầm, đã xác minh')
  }, 60_000)

  it('đang ở bậc trần → 409, không có gì để phục hồi', async () => {
    const seller = await newMember()
    await restore(master, seller.id, { reason: 'Thử phục hồi người chưa bị gì' }).expect(409)
  }, 60_000)

  it('phục hồi bậc KHÔNG xoá án 7 ngày — đó là việc của clear-rejections', async () => {
    const seller = await newMember()
    await setTrustLevel(seller.id, 1)
    const l = await postInternal(seller)
    expect(l.status).toBe('pending')
    await request(app)
      .patch(`/api/v1/moderation/listings/${l._id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ status: 'rejected', reason: 'Hàng cấm', severity: 'violation' })
      .expect(200)
    expect(await levelOf(seller.id)).toBe(0)

    await restore(master, seller.id, { reason: 'Xét lại: chỉ nhầm danh mục' }).expect(200)
    expect(await levelOf(seller.id)).toBe(2)

    // Bậc đã trần nhưng án vi phạm trong cửa sổ vẫn còn → vẫn chưa tự đăng được.
    const before = await quotaOf(seller)
    expect(before.standing.canSelfPublish).toBe(false)
    expect(before.standing.penalty.rejections).toBe(1)

    await request(app)
      .post(`/api/v1/users/${seller.id}/clear-rejections`)
      .set(bearer(master))
      .send({ reason: 'Xét lại: chỉ nhầm danh mục' })
      .expect(200)
    const after = await quotaOf(seller)
    expect(after.standing.penalty).toBeNull()
    expect(after.standing.canSelfPublish).toBe(true)
  }, 60_000)

  it('không phải master → 403, kể cả chủ nhóm của người đó', async () => {
    const seller = await newMember()
    await penalize(seller)
    await restore(owner, seller.id, { reason: 'Tôi gỡ nhầm' }).expect(403)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('thiếu hoặc quá ngắn lý do → 400; field lạ → 400', async () => {
    const seller = await newMember()
    await penalize(seller)
    await restore(master, seller.id, {}).expect(400)
    await restore(master, seller.id, { reason: 'ok' }).expect(400)
    await restore(master, seller.id, { reason: 'Đủ dài', note: 'x' }).expect(400)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('người dùng không tồn tại → 404', async () => {
    const ghost = new mongoose.Types.ObjectId().toString()
    await restore(master, ghost, { reason: 'Không có ai ở đây' }).expect(404)
  }, 60_000)
})
