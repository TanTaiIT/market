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
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * `?ward=` — tầng thứ hai của bộ lọc khu vực trên bảng tin, dưới `?province=`.
 *
 * Chốt quan trọng nhất không phải là "lọc được", mà là `ward` KHÔNG BAO GIỜ đứng một mình: tên
 * phường/xã lặp giữa các tỉnh ("Phường 1", "Xã Tân Lập" có ở hàng chục nơi), nên lọc xã trần là
 * gộp kết quả của những nơi cách nhau nghìn cây số rồi gọi đó là "gần đây". Cùng luật với
 * `createListingSchema` (xã phải thuộc tỉnh) — một bộ địa giới, một cách kiểm.
 */

let app: Application
let mongod: MongoMemoryReplSet
let seller: TestUser
let categoryId = ''

const PROVINCE = 'Hồ Chí Minh'
const WARD_A = 'Phường Bến Thành'
// Cùng tỉnh sau sáp nhập 01/07/2025 (Bình Dương cũ) — hai xã một tỉnh để chứng minh lọc đúng xã,
// không chỉ đúng tỉnh.
const WARD_B = 'Phường Thủ Dầu Một'

const list = (query: string) => request(app).get(`/api/v1/listings?${query}`)
const titles = (res: request.Response) => (res.body.data as { title: string }[]).map((l) => l.title)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung')
  seller = await registerUser(app, 'ban@ward.local', 'Người bán')

  for (const [title, ward] of [
    ['Bàn học Bến Thành', WARD_A],
    ['Ghế xoay Thủ Dầu Một', WARD_B],
  ] as const) {
    await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${seller.token}` })
      .send({
        ...listingPayload(title, categoryId),
        visibility: 'public',
        provinceCode: PROVINCE,
        location: { province: PROVINCE, ward },
      })
      .expect(201)
  }
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('GET /listings?province=&ward=', () => {
  it('chỉ tỉnh → cả hai tin; thêm xã → đúng một tin của xã đó', async () => {
    const byProvince = await list(`province=${encodeURIComponent(PROVINCE)}`).expect(200)
    expect(titles(byProvince).sort()).toEqual(['Bàn học Bến Thành', 'Ghế xoay Thủ Dầu Một'])

    const byWard = await list(
      `province=${encodeURIComponent(PROVINCE)}&ward=${encodeURIComponent(WARD_A)}`,
    ).expect(200)
    expect(titles(byWard)).toEqual(['Bàn học Bến Thành'])
  }, 60_000)

  it('xã KHÔNG có tỉnh → 400, không âm thầm gộp xã trùng tên của tỉnh khác', async () => {
    const res = await list(`ward=${encodeURIComponent(WARD_A)}`).expect(400)
    expect(JSON.stringify(res.body)).toMatch(/province|tỉnh/i)
  }, 60_000)

  it('xã không thuộc tỉnh đã chọn → 400, cùng luật với lúc đăng tin', async () => {
    await list(
      `province=${encodeURIComponent('Hà Nội')}&ward=${encodeURIComponent(WARD_A)}`,
    ).expect(400)
  }, 60_000)

  it('xã hợp lệ nhưng chưa có tin → rỗng, không lỗi', async () => {
    const res = await list(
      `province=${encodeURIComponent(PROVINCE)}&ward=${encodeURIComponent('Phường Phú Lợi')}`,
    ).expect(200)
    expect(res.body.data).toEqual([])
  }, 60_000)
})
