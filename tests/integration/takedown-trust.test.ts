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
  grantRole,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * GỠ tin (report `hide_target`, DELETE ở bàn duyệt) chỉ ghi án uy tín khi đủ ba điều:
 * tin đã từng tới tay người mua, người gỡ có quyền DUYỆT trên trục của tin, và không tự xử.
 *
 * Lỗ đã đo trước bản sửa: cửa gỡ rộng hơn cửa duyệt (`canTakedownListing` cho quản trị nhóm rút
 * tin sàn mang tên nhóm), mà hai đường gỡ lại `trustRepository.record(false)` vô điều kiện —
 * nên một admin nhóm tự báo cáo tin sàn của thành viên rồi bấm gỡ là người đó tụt bậc trên toàn
 * sàn, ở một trục admin ấy không có quyền phán.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let orgOwner: TestUser
/** Phụ trách ô (Đồ dùng × HCM) — người có quyền DUYỆT trên trục công khai. */
let catManager: TestUser
let buyer: TestUser
let categoryId = ''
const ORG = 'nhom-takedown'
const HCM = 'Hồ Chí Minh'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

const trustOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  return UserTrust.findOne({ userId }).lean().exec()
}

/** Bậc hiện tại; chưa có bản ghi = còn nguyên bậc mặc định (trần). */
const levelOf = async (userId: string) => {
  const { INITIAL_TRUST } = await import('../../src/features/trust/trust.policy')
  return (await trustOf(userId))?.level ?? INITIAL_TRUST.level
}

async function newMember(email: string, name: string) {
  const u = await registerUser(app, email, name)
  await addMember(u.id, orgIdOf(ORG))
  return u
}

/** Tin SÀN mang badge nhóm — thành viên đăng lên bảng chung, `organizationId` = nhóm. */
async function postMarketplaceFromOrg(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(title, categoryId), reach: 'marketplace', provinceCode: HCM })
    .expect(201)
  return res.body.data as { _id: string; status: string; organizationId: string | null }
}

/** Tin SÀN của người KHÔNG thuộc nhóm nào — báo cáo về nó nằm trên trục công khai (ô danh mục × tỉnh). */
async function postMarketplaceLone(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(who))
    .send({ ...listingPayload(title, categoryId), reach: 'marketplace', provinceCode: HCM })
    .expect(201)
  return res.body.data as { _id: string; status: string; organizationId: string | null }
}

async function postInternal(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(title, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

async function reportListing(who: TestUser, listingId: string) {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(bearer(who))
    .send({
      targetType: 'listing',
      targetId: listingId,
      kind: 'scam',
      quote: 'Yêu cầu chuyển khoản trước khi cho xem hàng',
    })
    .expect(201)
  return res.body.data.id as string
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-takedown')
  master = await makeMaster(app)
  orgOwner = await registerUser(app, 'owner@takedown.local', 'Chủ nhóm')
  catManager = await registerUser(app, 'catman@takedown.local', 'Phụ trách Đồ dùng HCM')
  buyer = await registerUser(app, 'buyer@takedown.local', 'Người mua')

  await createOrg(app, master.token, {
    name: 'Nhóm takedown',
    key: ORG,
    ownerEmail: orgOwner.email,
    provinceCode: HCM,
  })
  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId,
    provinceCodes: [HCM],
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Gỡ qua báo cáo — trục của TIN quyết định ai ghi được án', () => {
  it('quản trị nhóm gỡ tin SÀN mang tên nhóm (cửa gỡ) → tin ẩn, uy tín người bán KHÔNG đổi', async () => {
    const seller = await newMember('seller-1@takedown.local', 'Người bán 1')
    const listing = await postMarketplaceFromOrg(seller, 'Nồi chiên không dầu')
    expect(listing.status).toBe('active')
    expect(listing.organizationId).toBe(orgIdOf(ORG))

    const reportId = await reportListing(buyer, listing._id)
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(orgAuth(orgOwner.token, ORG))
      .send({ action: 'hide_target' })
      .expect(200)

    // Tin đã rời sàn — quyền rút tin mang tên mình vẫn nguyên.
    await request(app).get(`/api/v1/listings/${listing._id}`).expect(404)
    // Nhưng án lên hồ sơ toàn sàn thì không thuộc thẩm quyền của nhóm.
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('người phụ trách ô (quyền DUYỆT trục công khai) gỡ qua báo cáo → tụt bậc', async () => {
    // Người bán KHÔNG nhóm — ca thuần trục sàn. Tin sàn mang badge nhóm cũng lên trục này từ
    // audit 2.8, xem `takedown-trust-matrix` G8a.
    const seller = await registerUser(app, 'seller-2@takedown.local', 'Người bán 2')
    const listing = await postMarketplaceLone(seller, 'Máy xay sinh tố')
    expect(listing.status).toBe('active')
    expect(listing.organizationId).toBeNull()

    const reportId = await reportListing(buyer, listing._id)
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(catManager))
      .send({ action: 'hide_target' })
      .expect(200)

    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)
})

describe('Gỡ ở bàn duyệt — chỉ tin đã lên bảng, đúng trục, không tự xử', () => {
  it('gỡ tin NỘI BỘ đang hiển thị, kèm lý do → tụt bậc và người bán đọc được lý do', async () => {
    const seller = await newMember('seller-3@takedown.local', 'Người bán 3')
    const listing = await postInternal(seller, 'Bàn phím cơ')
    expect(listing.status).toBe('active')

    await request(app)
      .delete(`/api/v1/moderation/listings/${listing._id}`)
      .set(orgAuth(orgOwner.token, ORG))
      .send({ reason: 'Bán hàng giả' })
      .expect(200)

    expect(await levelOf(seller.id)).toBe(1)

    const inbox = await request(app).get('/api/v1/notifications').set(bearer(seller)).expect(200)
    const note = inbox.body.data.find((n: { title: string }) => n.title === 'Tin của bạn đã bị gỡ')
    expect(note?.body).toContain('Bán hàng giả')
  }, 60_000)

  it('gỡ tin đang CHỜ DUYỆT (chưa tới tay ai) → không phải hậu kiểm, không tụt bậc', async () => {
    const seller = await newMember('seller-4@takedown.local', 'Người bán 4')
    await setTrustLevel(seller.id, 1)
    const listing = await postInternal(seller, 'Ghế gaming')
    expect(listing.status).toBe('pending')

    await request(app)
      .delete(`/api/v1/moderation/listings/${listing._id}`)
      .set(orgAuth(orgOwner.token, ORG))
      .expect(200)

    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('quản trị nhóm gỡ tin SÀN mang tên nhóm ở bàn duyệt → cũng không tụt bậc', async () => {
    const seller = await newMember('seller-5@takedown.local', 'Người bán 5')
    const listing = await postMarketplaceFromOrg(seller, 'Tai nghe chống ồn')
    expect(listing.status).toBe('active')

    await request(app)
      .delete(`/api/v1/moderation/listings/${listing._id}`)
      .set(orgAuth(orgOwner.token, ORG))
      .expect(200)

    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('DELETE không kèm body vẫn chạy — client hiện tại không gửi lý do', async () => {
    const seller = await newMember('seller-6@takedown.local', 'Người bán 6')
    const listing = await postInternal(seller, 'Màn hình 27 inch')

    await request(app)
      .delete(`/api/v1/moderation/listings/${listing._id}`)
      .set(orgAuth(orgOwner.token, ORG))
      .expect(200)
  }, 60_000)
})
