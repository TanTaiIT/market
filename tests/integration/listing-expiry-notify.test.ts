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
import { listingExpiryService } from '../../src/features/listing/listing.expiry.service'

/** Tin hết hạn thì người bán phải được báo (audit 1.20/4.9) — rơi khỏi bảng im lặng là "app hỏng". */
let app: Application
let mongod: MongoMemoryReplSet
let seller: TestUser
let listingId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  const categoryId = await createCategory('Đồ dùng', 'do-dung-expiry-notify')
  seller = await registerUser(app, 'seller@expiry.local', 'Người bán')

  const res = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${seller.token}`)
    .send({
      ...listingPayload('Quạt điện cũ', categoryId),
      reach: 'marketplace',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  listingId = res.body.data._id

  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: ép hết hạn', () =>
    Listing.updateOne({ _id: listingId }, { expiresAt: new Date(Date.now() - 60_000) }).exec(),
  )
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('listing-expiry:sweep', () => {
  it('hạ tin quá hạn và gửi thông báo đích danh cho người bán', async () => {
    expect(await listingExpiryService.sweep()).toBe(1)

    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const doc = await runUnscoped('test: đọc tin', () =>
      Listing.findById(listingId).select('status').lean().exec(),
    )
    expect(doc?.status).toBe('expired')

    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${seller.token}`)
      .expect(200)
    const note = inbox.body.data.find(
      (n: { title: string }) => n.title === 'Tin của bạn đã hết hạn',
    )
    expect(note?.body).toContain('Quạt điện cũ')
  }, 60_000)

  it('lượt quét sau không còn gì và không báo lại', async () => {
    expect(await listingExpiryService.sweep()).toBe(0)
  })
})
