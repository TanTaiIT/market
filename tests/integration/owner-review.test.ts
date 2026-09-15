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
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { reviewOf } from '../../src/features/listing/listing.review'

/**
 * `review` — lời giải thích cho CHÍNH CHỦ vì sao tin đang chờ / bị từ chối.
 *
 * Ba chốt:
 *
 * 1. Hold của máy quét nhanh phải được LƯU lúc đăng (`autoApproval.holds`) — trước đây bị vứt,
 *    nên 3/3 tin bậc 2 bị giữ trong DB thật đều "chờ duyệt" mà không ai nói vì sao.
 * 2. `review` chỉ có trên `/listings/mine*`. DTO công khai KHÔNG mang nó — lý do một tin bị giữ
 *    là chuyện giữa người đăng với người duyệt, không phải của trang tin ai cũng đọc.
 * 3. Tin bị từ chối lấy đúng lời người duyệt gõ, không phải một câu chung.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let other: TestUser
let categoryId = ''

/** Giá "bình thường" của danh mục — 5 tin này làm mẫu để tin 10đ thành outlier. */
const NORMAL_PRICE = 14_000_000

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const post = (who: TestUser, body: Record<string, unknown>) =>
  request(app)
    .post('/api/v1/listings')
    .set(auth(who))
    .send({
      ...listingPayload('Tin', categoryId),
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
      ...body,
    })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Điện thoại', 'dien-thoai')
  master = await makeMaster(app)
  owner = await registerUser(app, 'chu@review.local', 'Chủ tin')
  other = await registerUser(app, 'khac@review.local', 'Người khác')

  // Mẫu giá: PRICE_MIN_SAMPLE = 5. Tài khoản mới ở bậc trần nên 5 tin này tự lên `active`.
  for (let i = 0; i < 5; i++) {
    await post(other, { title: `iPhone mẫu ${i}`, price: NORMAL_PRICE }).expect(201)
  }
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

async function mine(who: TestUser) {
  const res = await request(app).get('/api/v1/listings/mine').set(auth(who)).expect(200)
  return res.body.data as Array<{ _id: string; status: string; review?: Record<string, string> }>
}

describe('Tin bậc 2 bị máy quét giữ lại', () => {
  let heldId = ''

  it('giá 10đ trong danh mục 14 triệu → pending, và hold được LƯU trên tin', async () => {
    const res = await post(owner, { title: 'Điện thoại giá lạ', price: 10 }).expect(201)
    heldId = res.body.data._id
    expect(res.body.data.status).toBe('pending')

    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const row = await runUnscoped('test đọc hồ sơ tự-đăng', () =>
      Listing.findById(heldId).select('autoApproval').lean().exec(),
    )
    expect(row?.autoApproval?.reason).toBe('content_flagged')
    // Đây là thứ trước đây không có: mảng hold — nguồn duy nhất giải thích được cho người đăng.
    expect(row?.autoApproval?.holds).toEqual(['price_outlier'])
  }, 60_000)

  it('/listings/mine giải thích đúng lý do bằng câu chữ, kèm việc họ làm được', async () => {
    const held = (await mine(owner)).find((l) => l._id === heldId)
    expect(held?.review).toBeDefined()
    expect(held?.review?.state).toBe('pending')
    expect(held?.review?.title).toBe('Chờ duyệt')
    // Nói về GIÁ và nói ra việc kiểm lại đơn vị — không phải "content_flagged".
    expect(held?.review?.message).toMatch(/giá/i)
    expect(held?.review?.hint).toMatch(/đơn vị|số 0/i)
    expect(JSON.stringify(held?.review)).not.toContain('content_flagged')
  }, 60_000)

  it('/listings/mine/:id cũng mang review', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/mine/${heldId}`)
      .set(auth(owner))
      .expect(200)
    expect(res.body.data.review?.state).toBe('pending')
  }, 60_000)
})

describe('Review không rò ra DTO công khai, và không có khi không cần', () => {
  it('tin ĐANG HIỆN của chính chủ không có review (vắng field, không phải object rỗng)', async () => {
    const rows = await mine(other)
    const active = rows.find((l) => l.status === 'active')
    expect(active).toBeDefined()
    expect(active).not.toHaveProperty('review')
  }, 60_000)

  it('GET /listings/:id (công khai) không bao giờ mang review hay autoApproval', async () => {
    const rows = await mine(other)
    const active = rows.find((l) => l.status === 'active')!
    const res = await request(app).get(`/api/v1/listings/${active._id}`).expect(200)
    expect(res.body.data).not.toHaveProperty('review')
    expect(res.body.data).not.toHaveProperty('autoApproval')
  }, 60_000)
})

describe('Tin bị từ chối', () => {
  it('review lấy ĐÚNG lời người duyệt gõ, và hint nói được sửa lại', async () => {
    const created = await post(owner, { title: 'Tin sẽ bị từ chối', price: NORMAL_PRICE }).expect(
      201,
    )
    const id = created.body.data._id

    // Master duyệt được trục công khai; lý do là câu người thật gõ.
    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(auth(master))
      .send({ status: 'rejected', reason: 'Ảnh mờ, không thấy rõ sản phẩm' })
      .expect(200)

    const row = (await mine(owner)).find((l) => l._id === id)
    expect(row?.status).toBe('rejected')
    expect(row?.review?.state).toBe('rejected')
    expect(row?.review?.title).toBe('Bị từ chối')
    expect(row?.review?.message).toBe('Ảnh mờ, không thấy rõ sản phẩm')
    expect(row?.review?.hint).toMatch(/sửa/i)
  }, 60_000)
})

/** Gọi thẳng hàm thuần với một "tin" tối thiểu — không cần DB cho các nhánh không đi qua máy quét. */
const at = (status: string, autoApproval?: object, moderation?: object, machineReview?: object) =>
  reviewOf({ status, autoApproval, moderation, machineReview } as never)

describe('reviewOf — các mã không đến từ máy quét', () => {
  it('trust_too_low nói về uy tín và cách nâng bậc', () => {
    const r = at('pending', { trustLevel: 0, reason: 'trust_too_low' })
    expect(r?.message).toMatch(/uy tín|duyệt/i)
    expect(r?.hint).toMatch(/bậc/i)
  })

  it('pending_unverified = người ngoài nhóm, gợi ý xin vào', () => {
    const r = at('pending_unverified')
    expect(r?.message).toMatch(/thành viên/i)
    expect(r?.hint).toMatch(/xin vào/i)
  })

  it('tin seed không có hồ sơ → câu chung, không ném', () => {
    expect(at('pending')?.message).toBe('Tin đang chờ người duyệt xem.')
  })

  /**
   * Tin đăng TRƯỚC ngày `autoApproval.holds` tồn tại: đường tự-đăng chỉ ghi `content_flagged`,
   * nhưng job quét đêm đã chấm lại và ghi hold vào `machineReview`. Đây chính là hình dạng của
   * mọi tin đang kẹt "chờ duyệt" trong DB thật lúc feature này ra đời — không đọc được nguồn
   * phụ thì họ vẫn chỉ thấy câu chung.
   */
  it('content_flagged không có holds → đọc hold từ machineReview của job quét', () => {
    const r = at('pending', { trustLevel: 2, reason: 'content_flagged' }, undefined, {
      at: new Date(),
      verdict: 'held',
      holds: ['duplicate_title'],
    })
    expect(r?.message).toMatch(/cùng tiêu đề/i)
  })

  it('content_flagged không có hold ở đâu cả → câu chung về nội dung', () => {
    const r = at('pending', { trustLevel: 2, reason: 'content_flagged' })
    expect(r?.message).toMatch(/nội dung/i)
    expect(r?.hint).toBeUndefined()
  })

  it('từ chối vì vi phạm → hint cảnh báo khoá quyền đăng', () => {
    const r = at('rejected', undefined, { reason: 'Hàng cấm', severity: 'violation' })
    expect(r?.hint).toMatch(/khoá quyền đăng/i)
  })

  it('active / sold / expired → không có gì để giải thích', () => {
    for (const s of ['active', 'sold', 'expired', 'draft']) expect(at(s)).toBeUndefined()
  })
})
