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
  orgIdOf,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Quản chế (audit 1.12, quyết định 2026-09-26): quản trị nhóm VẪN tự duyệt được tin của mình,
 * nhưng master đặt ai vào diện quản chế thì người đó không tự đăng, máy không duyệt, và không
 * tự duyệt tin của chính mình — tin phải qua mắt người khác. Bậc uy tín không đổi, và họ vẫn
 * duyệt được tin của người khác.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let categoryId = ''
const ORG = 'nhom-quan-che'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function postInternal(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

async function readListing(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status autoApproval').lean().exec(),
  )
}

async function forceStatus(id: string, status: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: ép trạng thái', () => Listing.updateOne({ _id: id }, { status }).exec())
}

const setProbation = (id: string, body: object, by: TestUser = master) =>
  request(app).post(`/api/v1/users/${id}/probation`).set(bearer(by)).send(body)
const liftProbation = (id: string, by: TestUser = master) =>
  request(app).delete(`/api/v1/users/${id}/probation`).set(bearer(by))
const approve = (who: TestUser, listingId: string) =>
  request(app)
    .patch(`/api/v1/moderation/listings/${listingId}`)
    .set(orgAuth(who.token, ORG))
    .send({ status: 'active' })
const quota = (who: TestUser) =>
  request(app).get('/api/v1/listings/quota').set(orgAuth(who.token, ORG))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-probation')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@probation.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm quản chế', key: ORG, ownerEmail: owner.email })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Trước khi bị quản chế — quản trị nhóm tự duyệt được tin của mình', () => {
  it('tin của chủ nhóm tự lên (bậc trần), và tự duyệt một tin đang chờ không bị chặn', async () => {
    const l = await postInternal(owner)
    expect(l.status).toBe('active')

    await forceStatus(l._id, 'pending')
    await approve(owner, l._id).expect(200)
    expect((await readListing(l._id))?.status).toBe('active')
  }, 60_000)
})

describe('Đặt quản chế', () => {
  it('master đặt được: DTO mang án, bậc uy tín giữ nguyên, người bị đặt nhận thông báo', async () => {
    const res = await setProbation(owner.id, {
      reason: 'Tự duyệt tin sai quy định nhóm',
      days: 7,
    }).expect(200)

    expect(res.body.data.probation).toMatchObject({ reason: 'Tự duyệt tin sai quy định nhóm' })
    expect(res.body.data.probation.until).toBeTruthy()
    expect(res.body.data.trustLevel).toBe(2)

    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(owner.token, ORG))
      .expect(200)
    expect(
      inbox.body.data.some(
        (n: { title: string }) => n.title === 'Tài khoản của bạn đang bị quản chế',
      ),
    ).toBe(true)
  }, 60_000)

  it('đang quản chế: tin mới không tự lên, lý do ghi `probation`, màn quota nói rõ', async () => {
    const l = await postInternal(owner)
    expect(l.status).toBe('pending')
    expect((await readListing(l._id))?.autoApproval?.reason).toBe('probation')

    const q = await quota(owner).expect(200)
    expect(q.body.data.standing.canSelfPublish).toBe(false)
    expect(q.body.data.standing.probation).toMatchObject({
      reason: 'Tự duyệt tin sai quy định nhóm',
    })
  }, 60_000)

  it('tự duyệt tin của mình → 403; người khác (master) duyệt thì lên bình thường', async () => {
    const l = await postInternal(owner)
    expect(l.status).toBe('pending')

    const denied = await approve(owner, l._id)
    expect(denied.status).toBe(403)
    expect((await readListing(l._id))?.status).toBe('pending')

    await approve(master, l._id).expect(200)
    expect((await readListing(l._id))?.status).toBe('active')
  }, 60_000)

  it('người bị quản chế VẪN duyệt được tin của người khác — án chỉ về tin của họ', async () => {
    const member = await registerUser(app, 'member@probation.local', 'Thành viên')
    await addMember(member.id, orgIdOf(ORG))
    await setTrustLevel(member.id, 0)
    const l = await postInternal(member)
    expect(l.status).toBe('pending')

    await approve(owner, l._id).expect(200)
    expect((await readListing(l._id))?.status).toBe('active')
  }, 60_000)

  it('không quản chế được master (403), và chỉ master mới đặt được (403)', async () => {
    await setProbation(master.id, { reason: 'thử quản chế master' }).expect(403)
    await setProbation(owner.id, { reason: 'thử từ chủ nhóm' }, owner).expect(403)
  })

  it('lý do dưới 3 ký tự hay field lạ → 400', async () => {
    await setProbation(owner.id, { reason: 'ab' }).expect(400)
    await setProbation(owner.id, { reason: 'đủ dài', level: 0 }).expect(400)
  })
})

describe('Gỡ quản chế', () => {
  it('gỡ xong thì tin lại tự lên, DTO hết án; gỡ lần hai → 409', async () => {
    const res = await liftProbation(owner.id).expect(200)
    expect(res.body.data.probation).toBeNull()

    const l = await postInternal(owner)
    expect(l.status).toBe('active')

    await liftProbation(owner.id).expect(409)
  }, 60_000)

  it('án có hạn tự hết: `until` đã qua thì với luật đăng tin là không có án', async () => {
    const { trustRepository } = await import('../../src/features/trust/trust.repository')
    await trustRepository.setProbation(owner.id, {
      reason: 'án đã hết hạn',
      byUserId: new mongoose.Types.ObjectId(master.id),
      at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      until: new Date(Date.now() - 1000),
    })

    const l = await postInternal(owner)
    expect(l.status).toBe('active')
    const q = await quota(owner).expect(200)
    expect(q.body.data.standing.probation).toBeNull()

    // Bảng người dùng của master cũng không hiện án đã hết.
    const list = await request(app)
      .get(`/api/v1/users?q=${encodeURIComponent('owner@probation.local')}`)
      .set(bearer(master))
      .expect(200)
    const row = list.body.data.find((u: { id: string }) => u.id === owner.id)
    expect(row?.probation).toBeNull()
  }, 60_000)
})
