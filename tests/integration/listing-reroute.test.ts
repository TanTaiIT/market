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
 * Chuyển ô duyệt (audit 1.6): chạy được với tin sàn mang badge nhóm (từng 500 vì ghi có scope),
 * chỉ nhận tin đang chờ/đang hiện, đổi danh mục thì về hàng chờ + máy chấm lại + thuộc tính lọc
 * lại theo template mới, chỉ đổi tỉnh thì giữ trạng thái.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let seller: TestUser
let categoryId = ''
let otherCategoryId = ''
const ORG = 'nhom-reroute'
let seq = 0

const HCM = 'Hồ Chí Minh'
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function postMarketplace(who: TestUser, headers: Record<string, string>) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(headers)
    .send({
      ...listingPayload(`Tin số ${seq}`, categoryId),
      reach: 'marketplace',
      provinceCode: HCM,
    })
    .expect(201)
  return res.body.data as { _id: string; status: string; organizationId: string | null }
}

async function force(id: string, patch: Record<string, unknown>) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: ép trạng thái', () => Listing.updateOne({ _id: id }, patch).exec())
}

async function read(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () => Listing.findById(id).lean().exec())
}

const reroute = (id: string, body: object) =>
  request(app).patch(`/api/v1/moderation/listings/${id}/route`).set(bearer(master)).send(body)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-reroute')
  otherCategoryId = await createCategory('Điện tử', 'dien-tu-reroute')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@reroute.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm reroute', key: ORG, ownerEmail: owner.email })
  seller = await registerUser(app, 'seller@reroute.local', 'Người bán')
  await addMember(seller.id, orgIdOf(ORG))
  // Bậc 0 để tin vào hàng chờ, từ đó chọn trạng thái từng ca bằng tay.
  await setTrustLevel(seller.id, 0)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Chuyển ô duyệt', () => {
  it('tin sàn MANG BADGE NHÓM chuyển được (từng 500 vì nhánh ghi có scope)', async () => {
    const l = await postMarketplace(seller, orgAuth(seller.token, ORG))
    expect(l.organizationId).not.toBeNull()

    await reroute(l._id, { provinceCode: 'Hà Nội' }).expect(200)
    const doc = await read(l._id)
    expect(doc?.provinceCode).toBe('Hà Nội')
    expect(doc?.wardCode).toBeNull()
  }, 60_000)

  it('đổi danh mục: về hàng chờ, máy chấm lại, thuộc tính lọc theo template mới', async () => {
    const l = await postMarketplace(seller, bearer(seller))
    await force(l._id, { status: 'active', machineReview: { at: new Date(), verdict: 'approved' } })

    await reroute(l._id, { categoryId: otherCategoryId }).expect(200)
    const doc = await read(l._id)
    expect(doc?.category.toString()).toBe(otherCategoryId)
    expect(doc?.status).toBe('pending')
    expect(doc?.machineReview).toBeNull()
    expect(doc?.attrs).toEqual([])
  }, 60_000)

  it('chỉ đổi tỉnh trên tin ĐANG HIỆN thì giữ nguyên trạng thái', async () => {
    const l = await postMarketplace(seller, bearer(seller))
    await force(l._id, { status: 'active' })

    await reroute(l._id, { provinceCode: 'Hà Nội' }).expect(200)
    expect((await read(l._id))?.status).toBe('active')
  }, 60_000)

  it('tin đã từ chối / đã ẩn / đã bán không chuyển ô được — 400, không hồi sinh qua cửa sau', async () => {
    for (const status of ['rejected', 'hidden', 'sold']) {
      const l = await postMarketplace(seller, bearer(seller))
      await force(l._id, { status })
      const res = await reroute(l._id, { provinceCode: 'Hà Nội' })
      expect(res.status).toBe(400)
      expect((await read(l._id))?.status).toBe(status)
    }
  }, 60_000)

  it('tin TRONG NHÓM không thuộc bàn danh mục — 400', async () => {
    seq += 1
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(seller.token, ORG))
      .send({ ...listingPayload(`Tin nội bộ ${seq}`, categoryId), reach: 'members' })
      .expect(201)
    await reroute(res.body.data._id, { provinceCode: 'Hà Nội' }).expect(400)
  }, 60_000)

  it('không đổi gì thì 200 và tin nguyên trạng', async () => {
    const l = await postMarketplace(seller, bearer(seller))
    await reroute(l._id, { provinceCode: HCM }).expect(200)
    expect((await read(l._id))?.status).toBe('pending')
  }, 60_000)
})
