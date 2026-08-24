import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
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
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Phụ trách ô (Việc làm × TP.HCM) — không thuộc nhóm nào, đúng hình mẫu người gác trục danh mục. */
let catManager: TestUser
/** Phụ trách ô KHÁC — dùng để chứng minh phạm vi vẫn được tôn trọng. */
let otherCatManager: TestUser
let orgOwner: TestUser
/** Người bán không thuộc nhóm nào — nhân vật của lỗ hổng cũ. */
let loneSeller: TestUser
let orgMember: TestUser

let jobs = ''
let phones = ''
const HCM = 'Hồ Chí Minh'
const SLUG = 'truong-cong-khai'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  jobs = await createCategory('Việc làm', 'viec-lam')
  phones = await createCategory('Điện thoại', 'dien-thoai')

  master = await makeMaster(app)
  catManager = await registerUser(app, 'catman@pub.local', 'Phụ trách Việc làm HCM')
  otherCatManager = await registerUser(app, 'other@pub.local', 'Phụ trách Điện thoại HCM')
  orgOwner = await registerUser(app, 'owner@pub.local', 'Chủ nhóm')
  orgMember = await registerUser(app, 'member@pub.local', 'Thành viên nhóm')
  loneSeller = await registerUser(app, 'lone@pub.local', 'Người bán không nhóm')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(orgMember.id, 0)
  await setTrustLevel(loneSeller.id, 0)

  await createOrg(app, master.token, {
    name: 'Trường công khai',
    slug: SLUG,
    ownerEmail: orgOwner.email,
    provinceCode: HCM,
  })
  const { addMember } = await import('../helpers/fixtures')
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findOne({ slug: SLUG }).lean().exec()
  await addMember(orgMember.id, org!._id.toString())

  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId: jobs,
    provinceCodes: [HCM],
  })
  await grantRole({
    userId: otherCatManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId: phones,
    provinceCodes: [HCM],
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function postPublic(who: TestUser, title: string, categoryId: string, headers = {}) {
  return request(app)
    .post('/api/v1/listings')
    .set({ ...bearer(who), ...headers })
    .send({ ...listingPayload(title, categoryId), visibility: 'public', provinceCode: HCM })
}

const statusOf = async (id: string) => {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const doc = await runUnscoped('test đọc status', () =>
    Listing.findById(id).select('status organizationId').lean().exec(),
  )
  return doc
}

describe('Trục công khai — người phụ trách danh mục duyệt được', () => {
  it('tin của người KHÔNG thuộc nhóm nào: thấy, và bấm duyệt được', async () => {
    const created = await postPublic(loneSeller, 'Tuyển thợ hàn gấp', jobs).expect(201)
    const id = created.body.data._id
    expect(created.body.data.status).toBe('pending')

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(queue.body.data.map((l: { _id: string }) => l._id)).toContain(id)

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(bearer(catManager))
      .send({ status: 'active' })
      .expect(200)

    expect((await statusOf(id))?.status).toBe('active')
  }, 60_000)

  /**
   * Ca chặn thứ hai của lỗ cũ: tin công khai MANG BADGE nhóm. Nhánh ghi của `tenantPlugin` chỉ
   * cho đụng `organizationId: null` hoặc org trong scope, nên trước đây người phụ trách danh
   * mục (không có org trong scope) vẫn bị chặn ở tầng dữ liệu dù đã qua được middleware.
   */
  it('tin công khai của THÀNH VIÊN nhóm — vẫn duyệt được dù tin mang organizationId', async () => {
    const created = await postPublic(orgMember, 'Tuyển kế toán cho trường', jobs, {
      'X-Org-Slug': SLUG,
    }).expect(201)
    const id = created.body.data._id
    expect((await statusOf(id))?.organizationId).not.toBeNull()

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(bearer(catManager))
      .send({ status: 'active' })
      .expect(200)

    expect((await statusOf(id))?.status).toBe('active')
  }, 60_000)

  it('master duyệt được, KHÔNG cần mượn slug nhóm nào', async () => {
    const created = await postPublic(loneSeller, 'Tuyển bảo vệ ca đêm', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(master))
      .send({ status: 'active' })
      .expect(200)
  }, 60_000)

  it('gỡ tin cũng chạy trên trục công khai', async () => {
    const created = await postPublic(loneSeller, 'Tin sẽ bị gỡ', jobs).expect(201)

    await request(app)
      .delete(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(catManager))
      .expect(200)
  }, 60_000)
})

describe('Trục công khai — phạm vi KHÔNG được nới rộng', () => {
  it('phụ trách danh mục khác thì không đụng được', async () => {
    const created = await postPublic(loneSeller, 'Tuyển đầu bếp', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(otherCatManager))
      .send({ status: 'active' })
      .expect(403)

    expect((await statusOf(created.body.data._id))?.status).toBe('pending')
  }, 60_000)

  it('người dùng thường không có cửa nào — chặn ngay ở middleware', async () => {
    const created = await postPublic(loneSeller, 'Tuyển lễ tân', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(loneSeller))
      .send({ status: 'active' })
      .expect(403)
  }, 60_000)

  it('quản trị nhóm KHÔNG ghim được tin công khai lên bảng chung — hai trục vẫn tách bạch', async () => {
    const created = await postPublic(orgMember, 'Tin công khai của thành viên', jobs, {
      'X-Org-Slug': SLUG,
    }).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(orgAuth(orgOwner.token, SLUG))
      .send({ status: 'active' })
      .expect(403)

    expect((await statusOf(created.body.data._id))?.status).toBe('pending')
  }, 60_000)
})
