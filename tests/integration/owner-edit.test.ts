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
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Chính chủ sửa tin của mình — mọi trạng thái, mọi trục.
 *
 * Trước bản sửa, cả `GET /listings/:id` lẫn `PATCH /listings/:id` đều trả 404 cho tin
 * `pending`: đường đọc lọc `status ∈ PUBLIC_LISTING_STATUSES` ngay ở `incrementView`, còn
 * `PATCH` thì đi qua một lượt đọc CÓ SCOPE. Đo trên dữ liệu thật: 13/24 tin của một tài khoản
 * rơi vào ca đó, tức nút "sửa" ở bảng "Tin đã đăng" hỏng với hơn nửa số tin.
 *
 * Hai chốt ở đây, và chốt thứ hai quan trọng ngang chốt đầu: cửa mới KHÔNG được kéo theo việc
 * nới endpoint công khai — `GET /listings/:id` vẫn phải giấu tin chưa duyệt (quy tắc 7).
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let stranger: TestUser
let categoryId = ''
/** Tin `pending` trục công khai (`organizationId: null`) — ca của bảng "Tin đã đăng". */
let pendingId = ''
/** Tin nội bộ của một nhóm mà `owner` thuộc về. */
let internalId = ''

const SLUG = 'nhom-owner-edit'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@edit.local', 'Chủ tin')
  stranger = await registerUser(app, 'la@edit.local', 'Người lạ')

  await createOrg(app, master.token, { name: 'Nhóm', slug: SLUG, ownerEmail: owner.email })

  // Hạ bậc uy tín để tin mới nằm ở `pending` — đúng trạng thái đang hỏng.
  await setTrustLevel(owner.id, 0)

  const pub = await request(app)
    .post('/api/v1/listings')
    .set({ Authorization: `Bearer ${owner.token}` })
    .send({
      ...listingPayload('Tin công khai chờ duyệt', categoryId),
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  pendingId = pub.body.data._id

  const internal = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(owner.token, SLUG))
    .send({ ...listingPayload('Tin nội bộ chờ duyệt', categoryId), orgSlug: SLUG })
    .expect(201)
  internalId = internal.body.data._id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

describe('Chính chủ đọc và sửa tin chờ duyệt', () => {
  it('đọc được tin `pending` của mình qua /listings/mine/:id', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/mine/${pendingId}`)
      .set(auth(owner))
      .expect(200)

    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.title).toBe('Tin công khai chờ duyệt')
  }, 60_000)

  /**
   * Ca then chốt: KHÔNG gửi `X-Org-Slug`. `owner` thuộc đúng một nhóm nên `resolveTenant` tự
   * suy ra được — nhưng tin này ở trục công khai (`organizationId: null`) và đang `pending`, nên
   * vế công khai của predicate loại nó ra vì status. Đây chính là 404 mà nút sửa gặp.
   */
  it('SỬA được tin `pending` — trước đây 404', async () => {
    const res = await request(app)
      .patch(`/api/v1/listings/${pendingId}`)
      .set(auth(owner))
      .send({ title: 'Tiêu đề đã sửa' })
      .expect(200)

    expect(res.body.data.title).toBe('Tiêu đề đã sửa')

    // Ghi THẬT xuống DB, không phải chỉ phản chiếu payload: predicate ghi của plugin lọc trắng
    // thì `findByIdAndUpdate` trả về null mà không báo gì — đọc lại là cách duy nhất thấy điều đó.
    const back = await request(app)
      .get(`/api/v1/listings/mine/${pendingId}`)
      .set(auth(owner))
      .expect(200)
    expect(back.body.data.title).toBe('Tiêu đề đã sửa')
  }, 60_000)

  it('sửa được tin NỘI BỘ khi không gửi header org', async () => {
    const res = await request(app)
      .patch(`/api/v1/listings/${internalId}`)
      .set(auth(owner))
      .send({ title: 'Tin nội bộ đã sửa' })
      .expect(200)

    expect(res.body.data.title).toBe('Tin nội bộ đã sửa')
  }, 60_000)

  it('xoá được tin `pending` của mình', async () => {
    const doomed = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${owner.token}` })
      .send({
        ...listingPayload('Tin sẽ xoá', categoryId),
        visibility: 'public',
        provinceCode: 'Hồ Chí Minh',
      })
      .expect(201)

    await request(app)
      .delete(`/api/v1/listings/${doomed.body.data._id}`)
      .set(auth(owner))
      .expect(200)

    await request(app)
      .get(`/api/v1/listings/mine/${doomed.body.data._id}`)
      .set(auth(owner))
      .expect(404)
  }, 60_000)
})

describe('Cửa của chính chủ không mở cho ai khác', () => {
  /**
   * 404 chứ KHÔNG 403, và đây là một chốt bảo mật chứ không phải một lựa chọn mã lỗi: 403 nói
   * với người ngoài rằng tin đó tồn tại. Bản sửa đầu của tôi trả 403 và `tenant-isolation`
   * đã bắt ngay — giữ test này để lần sau không ai đổi lại.
   */
  it('người lạ đọc tin của người khác → 404, không lộ sự tồn tại', async () => {
    await request(app).get(`/api/v1/listings/mine/${pendingId}`).set(auth(stranger)).expect(404)
  }, 60_000)

  it('khách chưa đăng nhập → 401', async () => {
    await request(app).get(`/api/v1/listings/mine/${pendingId}`).expect(401)
  }, 60_000)

  it('id không tồn tại → 404', async () => {
    await request(app)
      .get(`/api/v1/listings/mine/${new mongoose.Types.ObjectId().toString()}`)
      .set(auth(owner))
      .expect(404)
  }, 60_000)

  /**
   * Chốt chống hồi quy: endpoint CÔNG KHAI phải giữ nguyên hợp đồng của nó.
   *
   * Nếu ai đó "sửa lỗi 404" bằng cách bỏ bộ lọc status trong `incrementView` thì test này đỏ —
   * và đó là điều phải đỏ, vì làm thế là để cả thiên hạ đọc tin chưa duyệt qua `/listings/:id`.
   */
  it('GET /listings/:id VẪN giấu tin chưa duyệt, kể cả với chính chủ', async () => {
    await request(app).get(`/api/v1/listings/${pendingId}`).set(auth(owner)).expect(404)
    await request(app).get(`/api/v1/listings/${pendingId}`).expect(404)
  }, 60_000)
})
