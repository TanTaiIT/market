import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  listingPayload,
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { listingExpiryService } from '../../src/features/listing/listing.expiry.service'
import { Listing } from '../../src/features/listing/listing.model'
import { runUnscoped } from '../../src/common/tenant/tenantContext'

let app: Application
let mongod: MongoMemoryReplSet

let seller: TestUser
let stranger: TestUser
let categoryId = ''
const HCM = 'Hồ Chí Minh'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ cũ', 'do-cu')
  seller = await registerUser(app, 'seller@expiry.local', 'Người bán')
  // Người bán thứ hai: vừa để thử 403, vừa để màn đối soát có một chủ tin sạch dữ liệu —
  // `seller` bị các ca trên bỏ lại đầy tin quá hạn nên không đếm được gì chắc chắn.
  stranger = await registerUser(app, 'stranger@expiry.local', 'Người bán khác')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

/** Tin công khai của người ngoài nhóm vào `pending`; ép ACTIVE để có đối tượng cho job quét. */
async function postActive(title: string, who: TestUser = seller) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(who))
    .send({ ...listingPayload(title, categoryId), visibility: 'public', provinceCode: HCM })
    .expect(201)
  const id = res.body.data._id as string
  await publishListing(id)
  return id
}

/** Lùi hạn về quá khứ thay vì chờ 30 ngày — cùng cách machine-review test dựng hàng đợi. */
const setExpiry = (id: string, at: Date) =>
  runUnscoped('test đặt hạn tin', () => Listing.updateOne({ _id: id }, { expiresAt: at }).exec())

const statusOf = async (id: string) =>
  runUnscoped('test đọc status', async () => {
    const doc = await Listing.findById(id).select('status').lean().exec()
    return doc?.status
  })

const setStatus = (id: string, status: string) =>
  runUnscoped('test đặt status', () => Listing.updateOne({ _id: id }, { status }).exec())

const YESTERDAY = () => new Date(Date.now() - 24 * 60 * 60 * 1000)
const NEXT_WEEK = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

describe('Hết hạn tin — job hạ trạng thái, không xoá', () => {
  it('hạ tin quá hạn xuống `expired` và không đụng tin còn hạn', async () => {
    const due = await postActive('Bàn gỗ quá hạn')
    const fresh = await postActive('Bàn gỗ còn hạn')
    await setExpiry(due, YESTERDAY())
    await setExpiry(fresh, NEXT_WEEK())

    expect(await listingExpiryService.sweep()).toBe(1)

    expect(await statusOf(due)).toBe('expired')
    expect(await statusOf(fresh)).toBe('active')
  }, 60_000)

  /**
   * Ca chặn cho chính lý do bỏ TTL index: tin hết hạn phải CÒN ĐÓ. Mất nó thì người bán không
   * còn gì để trả lời "vẫn còn" rồi gia hạn, và mọi link đã chia sẻ thành 404.
   */
  it('tin hết hạn rơi khỏi bảng tin nhưng trang chi tiết vẫn xem được', async () => {
    const id = await postActive('Ghế sofa hết hạn')
    await setExpiry(id, YESTERDAY())
    await listingExpiryService.sweep()

    const feed = await request(app).get('/api/v1/listings').expect(200)
    expect(feed.body.data.map((l: { _id: string }) => l._id)).not.toContain(id)

    const detail = await request(app).get(`/api/v1/listings/${id}`).expect(200)
    expect(detail.body.data.status).toBe('expired')
  }, 60_000)

  /**
   * Quét chỉ được chạm `active`. Tin `hidden` là một phán quyết của người duyệt — để job ghi đè
   * thành `expired` là xoá dấu vết vì sao tin bị ẩn, và cú `renew` sau đó sẽ bật lại một tin
   * đang bị cấm hiển thị.
   */
  it('không đụng tin đã bị ẩn dù quá hạn', async () => {
    const id = await postActive('Tủ lạnh bị ẩn')
    await setStatus(id, 'hidden')
    await setExpiry(id, YESTERDAY())

    expect(await listingExpiryService.sweep()).toBe(0)
    expect(await statusOf(id)).toBe('hidden')
  }, 60_000)

  it('quét lại không hạ thêm lần nữa', async () => {
    const id = await postActive('Xe đạp quá hạn')
    await setExpiry(id, YESTERDAY())

    expect(await listingExpiryService.sweep()).toBe(1)
    expect(await listingExpiryService.sweep()).toBe(0)
    expect(await statusOf(id)).toBe('expired')
  }, 60_000)

  /**
   * Gác quyết định, không gác hành vi: TTL index quay lại là Mongo xoá thật tin tới hạn và cả
   * luồng gia hạn mất đối tượng — mà lỗi đó chỉ lộ ra sau 30 ngày trên prod, không test nào
   * khác kịp thấy. Assert trên schema vì schema mới là SoT; gỡ index đã có trong DB là việc
   * của `migrate:listing-expiry`.
   */
  it('schema KHÔNG được có TTL index trên expiresAt', () => {
    const ttl = Listing.schema
      .indexes()
      .filter(([, options]) => options && 'expireAfterSeconds' in options)
    expect(ttl).toEqual([])
  })
})

const expiryOf = async (id: string) =>
  runUnscoped('test đọc hạn', async () => {
    const doc = await Listing.findById(id).select('expiresAt rankAt').lean().exec()
    return doc
  })

describe('Gia hạn / đã bán — hai câu trả lời của chính chủ', () => {
  it('gia hạn bật tin hết hạn về active và đẩy hạn ra tương lai', async () => {
    const id = await postActive('Loa bluetooth hết hạn')
    await setExpiry(id, YESTERDAY())
    await listingExpiryService.sweep()
    const before = await expiryOf(id)

    const res = await request(app)
      .post(`/api/v1/listings/${id}/renew`)
      .set(bearer(seller))
      .expect(200)

    expect(res.body.data.status).toBe('active')
    const after = await expiryOf(id)
    expect(after!.expiresAt!.getTime()).toBeGreaterThan(Date.now())
    // Gia hạn KHÔNG được là một cú đẩy tin miễn phí — xem `listingService.renew`.
    expect(after!.rankAt!.getTime()).toBe(before!.rankAt!.getTime())
  }, 60_000)

  it('gia hạn xong tin quay lại bảng tin', async () => {
    const id = await postActive('Máy khoan hết hạn')
    await setExpiry(id, YESTERDAY())
    await listingExpiryService.sweep()

    await request(app).post(`/api/v1/listings/${id}/renew`).set(bearer(seller)).expect(200)

    const feed = await request(app).get('/api/v1/listings').expect(200)
    expect(feed.body.data.map((l: { _id: string }) => l._id)).toContain(id)
  }, 60_000)

  it('người khác không gia hạn được tin của mình', async () => {
    const id = await postActive('Quạt điện của người khác')
    await request(app).post(`/api/v1/listings/${id}/renew`).set(bearer(stranger)).expect(403)
  }, 60_000)

  /**
   * Chốt quan trọng nhất của hai route này: chúng KHÔNG được thành đường để chủ tin tự lật
   * phán quyết của người duyệt. Tin `hidden` gia hạn được là tin bị ẩn tự bật lại `active`.
   */
  it('không gia hạn được tin đang bị ẩn', async () => {
    const id = await postActive('Nồi cơm bị ẩn')
    await setStatus(id, 'hidden')
    await request(app).post(`/api/v1/listings/${id}/renew`).set(bearer(seller)).expect(400)
    expect(await statusOf(id)).toBe('hidden')
  }, 60_000)

  it('đánh dấu đã bán, bấm hai lần vẫn 200 và tin rơi khỏi bảng tin', async () => {
    const id = await postActive('Máy ảnh đã bán')

    await request(app).post(`/api/v1/listings/${id}/sold`).set(bearer(seller)).expect(200)
    // Nút này sẽ nằm trong push notification — bấm lại không được thành lỗi.
    await request(app).post(`/api/v1/listings/${id}/sold`).set(bearer(seller)).expect(200)

    expect(await statusOf(id)).toBe('sold')
    const feed = await request(app).get('/api/v1/listings').expect(200)
    expect(feed.body.data.map((l: { _id: string }) => l._id)).not.toContain(id)
  }, 60_000)

  /**
   * Trạng thái dựng thẳng ở model: bậc tín nhiệm của `seller` đã lên sau mấy tin sạch ở trên
   * nên tin đăng mới vào thẳng `active` — không đặt tay thì ca này không còn kiểm điều nó nói.
   */
  it('không đánh dấu đã bán cho tin chờ duyệt', async () => {
    const id = await postActive('Tin chờ duyệt')
    await setStatus(id, 'pending')

    await request(app).post(`/api/v1/listings/${id}/sold`).set(bearer(seller)).expect(400)
    expect(await statusOf(id)).toBe('pending')
  }, 60_000)
})

describe('Đối soát trước khi đăng tin mới', () => {
  it('quota mang theo tin hết hạn và tin sắp hết hạn, bỏ qua tin còn dài hạn', async () => {
    const due = await postActive('Bếp từ hết hạn', stranger)
    const soon = await postActive('Bếp từ sắp hết hạn', stranger)
    const far = await postActive('Bếp từ còn dài hạn', stranger)
    await setExpiry(due, YESTERDAY())
    await setExpiry(soon, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    await setExpiry(far, new Date(Date.now() + 20 * 24 * 60 * 60 * 1000))
    await listingExpiryService.sweep()

    const res = await request(app).get('/api/v1/listings/quota').set(bearer(stranger)).expect(200)

    const ids = res.body.data.needsReconcile.map((l: { _id: string }) => l._id)
    expect(ids).toContain(due)
    expect(ids).toContain(soon)
    expect(ids).not.toContain(far)
    // Cũ nhất trước: màn đối soát hỏi tin nào bức thiết hơn trước.
    expect(ids[0]).toBe(due)
  }, 60_000)

  it('trả lời xong thì tin rời khỏi danh sách đối soát', async () => {
    const id = await postActive('Xe máy cần đối soát', stranger)
    await setExpiry(id, YESTERDAY())
    await listingExpiryService.sweep()

    await request(app).post(`/api/v1/listings/${id}/sold`).set(bearer(stranger)).expect(200)

    const res = await request(app).get('/api/v1/listings/quota').set(bearer(stranger)).expect(200)
    expect(res.body.data.needsReconcile.map((l: { _id: string }) => l._id)).not.toContain(id)
  }, 60_000)
})
