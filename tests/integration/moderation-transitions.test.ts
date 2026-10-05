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
import { listingRepository } from '../../src/features/listing/listing.repository'

/**
 * Máy trạng thái của bàn duyệt (audit 1.4) — `MODERATION_TRANSITIONS`.
 *
 * Trước bản sửa `setModerationStatus` ghi vô điều kiện: `sold → active` hồi sinh tin đã bán,
 * `expired → active` gia hạn hộ, và bấm "duyệt" lần hai lên tin đang active cộng thêm một bài
 * sạch mỗi lần bấm — một nhóm thân thiện bấm 5 lần là trả bậc cho người vừa bị phạt.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let categoryId = ''
const ORG = 'nhom-transitions'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const asOwner = () => orgAuth(owner.token, ORG)

async function newSeller(level?: number) {
  seq += 1
  const u = await registerUser(app, `seller-${seq}@tr.local`, `Người bán ${seq}`)
  await addMember(u.id, orgIdOf(ORG))
  if (level !== undefined) await setTrustLevel(u.id, level)
  return u
}

async function post(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

const decide = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .patch(`/api/v1/moderation/listings/${id}`)
    .set(asOwner())
    .send({ status, ...extra })

async function setDoc(id: string, patch: Record<string, unknown>) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test sửa tin', () => Listing.updateOne({ _id: id }, patch).exec())
}

const trustOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  return UserTrust.findOne({ userId }).lean().exec()
}

const activityCount = async () =>
  (await request(app).get('/api/v1/moderation/activity').set(asOwner()).expect(200)).body.meta
    .total as number

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-tr')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@tr.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm TR', key: ORG, ownerEmail: owner.email })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Bàn duyệt không hồi sinh tin đã rời bảng theo ý chủ tin', () => {
  it('sold → active: 400', async () => {
    const seller = await newSeller()
    const l = await post(seller)
    await request(app).post(`/api/v1/listings/${l._id}/sold`).set(bearer(seller)).expect(200)

    await decide(l._id, 'active').expect(400)
  }, 60_000)

  it('expired → active: 400 — gia hạn là việc của chính chủ', async () => {
    const seller = await newSeller()
    const l = await post(seller)
    await setDoc(l._id, { status: 'expired' })

    await decide(l._id, 'active').expect(400)
  }, 60_000)

  it('rejected → hidden: 400 — tin đã từ chối không ở trên bảng để mà ẩn', async () => {
    const seller = await newSeller(1)
    const l = await post(seller)
    expect(l.status).toBe('pending')
    await decide(l._id, 'rejected', { reason: 'Ảnh mờ' }).expect(200)

    await decide(l._id, 'hidden').expect(400)
  }, 60_000)

  it('sold → hidden vẫn được: ẩn là thao tác vận hành, không phải hồi sinh', async () => {
    const seller = await newSeller()
    const l = await post(seller)
    await request(app).post(`/api/v1/listings/${l._id}/sold`).set(bearer(seller)).expect(200)

    const res = await decide(l._id, 'hidden').expect(200)
    expect(res.body.data.status).toBe('hidden')
  }, 60_000)
})

describe('Các chuyển trạng thái hợp lệ', () => {
  it('hidden → active (mở lại) và rejected → active (đổi ý) đều 200', async () => {
    const seller = await newSeller(1)
    const hiddenOne = await post(seller)
    await decide(hiddenOne._id, 'hidden').expect(200)
    expect((await decide(hiddenOne._id, 'active')).status).toBe(200)

    const rejectedOne = await post(seller)
    await decide(rejectedOne._id, 'rejected', { reason: 'Ảnh mờ' }).expect(200)
    expect((await decide(rejectedOne._id, 'active')).status).toBe(200)
  }, 60_000)

  it('pending → hidden: 200 (dọn hàng đợi mà không phán quyết)', async () => {
    const seller = await newSeller(1)
    const l = await post(seller)
    expect(l.status).toBe('pending')
    const res = await decide(l._id, 'hidden').expect(200)
    expect(res.body.data.status).toBe('hidden')
  }, 60_000)
})

describe('Cùng trạng thái = no-op', () => {
  it('bấm duyệt lần hai lên tin đang active → 200 nhưng KHÔNG cộng uy tín, không thêm nhật ký', async () => {
    const seller = await newSeller(1)
    const l = await post(seller)
    expect(l.status).toBe('pending')

    await decide(l._id, 'active').expect(200)
    expect(await trustOf(seller.id)).toMatchObject({ cleanApprovals: 6 })
    const logsAfterFirst = await activityCount()

    for (let i = 0; i < 3; i += 1) await decide(l._id, 'active').expect(200)

    expect(await trustOf(seller.id)).toMatchObject({ cleanApprovals: 6 })
    expect(await activityCount()).toBe(logsAfterFirst)
  }, 60_000)
})

describe('Chốt trạng thái khi ghi (compare-and-set)', () => {
  it('tin đã đổi tay giữa chừng thì lượt ghi sau khớp 0 document', async () => {
    const seller = await newSeller()
    const l = await post(seller)
    expect(l.status).toBe('active')

    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    // Người thứ hai đọc thấy `pending` từ trước, nhưng tin đã `active` — ghi phải trượt.
    const stale = await runUnscoped('test CAS', () =>
      listingRepository.updateByIdIfStatus(l._id, 'pending', { status: 'rejected' }).exec(),
    )
    expect(stale).toBeNull()

    const fresh = await runUnscoped('test CAS', () =>
      listingRepository.updateByIdIfStatus(l._id, 'active', { status: 'hidden' }).exec(),
    )
    expect(fresh?.status).toBe('hidden')
  }, 60_000)
})
