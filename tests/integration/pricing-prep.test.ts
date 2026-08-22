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
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
const ORG_SLUG = 'chuan-bi-xu'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@pricing.local', 'Người bán')
  await createOrg(app, master.token, {
    name: 'Org chuẩn bị Xu',
    slug: ORG_SLUG,
    ownerEmail: seller.email,
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function postListing(title: string) {
  return request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG_SLUG))
    .send({
      title,
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://example.com/a.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
}

describe('Chuẩn bị hệ Xu — field phí trong hợp đồng API', () => {
  it('đăng tin trả biên lai phí trong meta — giai đoạn miễn phí là { 0, xu }', async () => {
    const res = await postListing('Tin đầu tiên mang biên lai phí').expect(201)

    expect(res.body.meta).toMatchObject({ fee: { amount: 0, currency: 'xu' } })
  }, 60_000)

  it('màn hình quota báo luôn phí — form đăng chỉ cần hỏi một endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/listings/quota')
      .set(orgAuth(seller.token, ORG_SLUG))
      .expect(200)

    expect(res.body.data.fee).toEqual({ amount: 0, currency: 'xu' })
    expect(res.body.data.limit).toBeGreaterThan(0)
  }, 60_000)
})

describe('Chuẩn bị hệ Xu — số liệu định giá cho master', () => {
  it('master đọc được tổng lượt đăng, số người đăng và biểu đồ phân bố', async () => {
    await postListing('Tin thứ hai cho số liệu').expect(201)

    const res = await request(app)
      .get('/api/v1/listings/posting-stats')
      .set({ Authorization: `Bearer ${master.token}` })
      .expect(200)

    expect(res.body.data.totalPosts).toBeGreaterThanOrEqual(2)
    expect(res.body.data.distinctPosters).toBeGreaterThanOrEqual(1)
    expect(res.body.data.byCategory[0]).toMatchObject({ _id: categoryId })
    // seller đăng 2 tin → rơi vào giỏ [2,4) của biểu đồ ai-đăng-bao-nhiêu.
    expect(
      res.body.data.posterHistogram.find((b: { _id: number | string }) => b._id === 2)?.users,
    ).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('người thường không đọc được số liệu nền tảng', async () => {
    await request(app)
      .get('/api/v1/listings/posting-stats')
      .set({ Authorization: `Bearer ${seller.token}` })
      .expect(403)
  })

  it('cửa sổ đo ngoài khoảng cho phép bị zod chặn', async () => {
    await request(app)
      .get('/api/v1/listings/posting-stats?days=3')
      .set({ Authorization: `Bearer ${master.token}` })
      .expect(400)
  })
})
