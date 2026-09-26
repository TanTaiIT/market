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
import { CASCADE_HIDE_KIND } from '../../src/common/constants'

/** Tắt danh mục kéo tin theo, mở lại trả tin về (audit 1.20). */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
let otherCategoryId = ''
let inCategory = ''
let elsewhere = ''

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

// Tiêu đề phải KHÁC nhau: hai tin cùng tiêu đề trong 7 ngày là máy giữ tin thứ hai (`duplicate_title`).
async function post(category: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(seller))
    .send({
      ...listingPayload(title, category),
      reach: 'marketplace',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  expect(res.body.data.status).toBe('active')
  return res.body.data._id as string
}

async function read(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status moderation').lean().exec(),
  )
}

const setActive = (isActive: boolean) =>
  request(app).patch(`/api/v1/categories/${categoryId}`).set(bearer(master)).send({ isActive })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Sắp đóng', 'sap-dong')
  otherCategoryId = await createCategory('Vẫn mở', 'van-mo')
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@catoff.local', 'Người bán')
  inCategory = await post(categoryId, 'Bàn học gỗ')
  elsewhere = await post(otherCategoryId, 'Ghế xoay văn phòng')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tắt / mở danh mục', () => {
  it('tắt: tin đang hiện trong danh mục ẩn với dấu cascade; danh mục khác không đụng', async () => {
    await setActive(false).expect(200)

    const hidden = await read(inCategory)
    expect(hidden?.status).toBe('hidden')
    expect(hidden?.moderation).toMatchObject({ cascade: CASCADE_HIDE_KIND.CATEGORY_DISABLED })
    expect((await read(elsewhere))?.status).toBe('active')

    await request(app).get(`/api/v1/listings/${inCategory}`).expect(404)
    // Đăng mới vào danh mục đã đóng cũng bị chặn.
    await request(app)
      .post('/api/v1/listings')
      .set(bearer(seller))
      .send({
        ...listingPayload('Tin vào gian đã đóng', categoryId),
        reach: 'marketplace',
        provinceCode: 'Hồ Chí Minh',
      })
      .expect(400)
  }, 60_000)

  it('mở lại: đúng lô đó về active', async () => {
    await setActive(true).expect(200)
    expect((await read(inCategory))?.status).toBe('active')
    await request(app).get(`/api/v1/listings/${inCategory}`).expect(200)
  }, 60_000)
})
