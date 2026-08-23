import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, makeMaster, registerUser, startTestDb } from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let buyer: TestUser

const asMaster = () => ({ Authorization: `Bearer ${master.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  buyer = await registerUser(app, 'buyer@products.local', 'Người mua')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Catalog gói tin — master xuất bản qua API', () => {
  let productId = ''

  it('tạo gói nháp: chưa giá, chưa bật — hợp lệ', async () => {
    const res = await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({
        code: 'Featured_7d_Sale',
        name: 'Tin nổi bật 7 ngày — ưu đãi khai trương',
        description: 'Giảm giá đợt đầu cho người bán sớm',
        effect: 'featured',
        durationDays: 7,
      })
      .expect(201)

    // Code chuẩn hoá lowercase — 'Featured_7d_Sale' và 'featured_7d_sale' là một gói.
    expect(res.body.data.code).toBe('featured_7d_sale')
    expect(res.body.data.enabled).toBe(false)
    expect(res.body.data.price).toBeNull()
    productId = res.body.data._id
  })

  it('mở bán mà chưa có giá thì bị chặn — kể cả qua đường PATCH từng phần', async () => {
    const res = await request(app)
      .patch(`/api/v1/listing-products/${productId}`)
      .set(asMaster())
      .send({ enabled: true })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('giá')
  })

  it('điền giá rồi bật — gói xuất hiện trên catalog công khai', async () => {
    await request(app)
      .patch(`/api/v1/listing-products/${productId}`)
      .set(asMaster())
      .send({ price: { amount: 5 }, enabled: true })
      .expect(200)

    const pub = await request(app).get('/api/v1/listings/products').expect(200)
    expect(pub.body.data).toHaveLength(1)
    expect(pub.body.data[0]).toMatchObject({
      code: 'featured_7d_sale',
      enabled: true,
      price: { amount: 5, currency: 'xu' },
    })
    // Vết quản trị không rò ra catalog.
    expect(pub.body.data[0].createdBy).toBeUndefined()
  })

  it('gói nháp KHÔNG xuất hiện công khai, nhưng master vẫn thấy đủ', async () => {
    await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({ code: 'bump', name: 'Đẩy tin', effect: 'rank_to_top', cooldownHours: 24 })
      .expect(201)

    const pub = await request(app).get('/api/v1/listings/products').expect(200)
    expect(pub.body.data.map((p: { code: string }) => p.code)).toEqual(['featured_7d_sale'])

    const admin = await request(app).get('/api/v1/listing-products').set(asMaster()).expect(200)
    expect(admin.body.data).toHaveLength(2)
  })

  it('luật hiệu ứng: đẩy tin kèm thời hạn là vô nghĩa → 400; gói thời hạn thiếu ngày → 400', async () => {
    await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({ code: 'bump_7d', name: 'Đẩy tin 7 ngày?', effect: 'rank_to_top', durationDays: 7 })
      .expect(400)

    await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({ code: 'featured_x', name: 'Nổi bật không ngày', effect: 'featured' })
      .expect(400)
  })

  it('trùng code → 409; sửa code bị schema chặn vì nó là định danh bất biến', async () => {
    await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({ code: 'bump', name: 'Đẩy tin bản sao', effect: 'rank_to_top' })
      .expect(409)

    await request(app)
      .patch(`/api/v1/listing-products/${productId}`)
      .set(asMaster())
      .send({ code: 'doi_ten_code' })
      .expect(400)
  })

  it('người thường không đụng được bàn quản trị catalog', async () => {
    await request(app)
      .get('/api/v1/listing-products')
      .set({ Authorization: `Bearer ${buyer.token}` })
      .expect(403)

    await request(app)
      .post('/api/v1/listing-products')
      .set({ Authorization: `Bearer ${buyer.token}` })
      .send({ code: 'hack', name: 'Gói lậu', effect: 'rank_to_top' })
      .expect(403)
  })

  it('xoá gói → biến khỏi cả hai danh sách', async () => {
    await request(app).delete(`/api/v1/listing-products/${productId}`).set(asMaster()).expect(200)

    const pub = await request(app).get('/api/v1/listings/products').expect(200)
    expect(pub.body.data).toHaveLength(0)
  })
})

describe('Catalog gói tin — sửa từng phần không đạp lên nhau', () => {
  it('PATCH chỉ đổi tên thì giá đang có KHÔNG bị ghi đè', async () => {
    const created = await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({
        code: 'extend_30d',
        name: 'Gia hạn 30 ngày',
        effect: 'extend_expiry',
        durationDays: 30,
        price: { amount: 3 },
      })
      .expect(201)

    const res = await request(app)
      .patch(`/api/v1/listing-products/${created.body.data._id}`)
      .set(asMaster())
      .send({ name: 'Gia hạn 30 ngày — đổi tên' })
      .expect(200)

    expect(res.body.data.price).toEqual({ amount: 3, currency: 'xu' })
  })

  it('gửi price: null là CỐ Ý xoá giá — và gói đang bán thì bị chặn', async () => {
    const created = await request(app)
      .post('/api/v1/listing-products')
      .set(asMaster())
      .send({
        code: 'featured_3d',
        name: 'Nổi bật 3 ngày',
        effect: 'featured',
        durationDays: 3,
        price: { amount: 2 },
        enabled: true,
      })
      .expect(201)

    await request(app)
      .patch(`/api/v1/listing-products/${created.body.data._id}`)
      .set(asMaster())
      .send({ price: null })
      .expect(400)

    // Ngừng bán trước rồi mới xoá giá được.
    await request(app)
      .patch(`/api/v1/listing-products/${created.body.data._id}`)
      .set(asMaster())
      .send({ price: null, enabled: false })
      .expect(200)
  })
})
