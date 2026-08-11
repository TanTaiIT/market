import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

const CATEGORY_ID = new Types.ObjectId().toString()
// Cùng một email ở hai org phải tạo được hai tài khoản riêng (quyết định #2).
const SHARED_EMAIL = 'owner@example.com'
const PASSWORD = 'password123'

const orgA = { token: '', ownerId: '', orgId: '', listingId: '' }
const orgB = { token: '', ownerId: '', orgId: '', listingId: '' }

function listingPayload(title: string) {
  return {
    title,
    description: 'Mô tả đủ dài cho validation',
    price: 1000000,
    categoryId: CATEGORY_ID,
    images: ['https://example.com/a.jpg'],
    location: { coordinates: [106.7, 10.77], province: 'Hồ Chí Minh' },
  }
}

async function registerOrg(slug: string) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({
      organizationName: `Org ${slug}`,
      organizationSlug: slug,
      name: `Owner ${slug}`,
      email: SHARED_EMAIL,
      password: PASSWORD,
    })
  expect(res.status).toBe(201)
  return {
    token: res.body.data.tokens.accessToken as string,
    ownerId: res.body.data.user.id as string,
    orgId: res.body.data.user.organizationId as string,
    listingId: '',
  }
}

async function createListing(token: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${token}`)
    .send(listingPayload(title))
  expect(res.status).toBe(201)
  return res.body.data._id as string
}

/** Tin mới vào PENDING và chưa có route duyệt tin — bật ACTIVE thẳng ở tầng model. */
async function publish(listingId: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test fixture', () =>
    Listing.updateOne({ _id: listingId }, { status: 'active' }).exec(),
  )
}

beforeAll(async () => {
  // Transaction (đăng ký Organization) đòi replica set — standalone sẽ lỗi ngay.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  // Giữ URI ở biến cục bộ: đọc lại qua process.env cho ra `string | undefined`.
  const uri = mongod.getUri()
  process.env.MONGO_URI = uri
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(uri)

  const { createApp } = await import('../../src/app')
  app = createApp()

  Object.assign(orgA, await registerOrg('org-a'))
  Object.assign(orgB, await registerOrg('org-b'))
  orgA.listingId = await createListing(orgA.token, 'Tin đăng của org A')
  orgB.listingId = await createListing(orgB.token, 'Tin đăng của org B')
  await publish(orgA.listingId)
  await publish(orgB.listingId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Cách ly giữa hai org độc lập', () => {
  it('trùng email ở 2 org tạo được 2 tài khoản riêng', () => {
    expect(orgA.ownerId).not.toBe(orgB.ownerId)
    expect(orgA.orgId).not.toBe(orgB.orgId)
  })

  it('GET /listings chỉ trả tin của org mình', async () => {
    const res = await request(app)
      .get('/api/v1/listings')
      .set('Authorization', `Bearer ${orgA.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]._id).toBe(orgA.listingId)
  })

  it('đọc tin org khác trả 404 chứ không phải 403 — không lộ sự tồn tại', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${orgB.listingId}`)
      .set('Authorization', `Bearer ${orgA.token}`)
    expect(res.status).toBe(404)
  })

  it('sửa và xoá tin org khác cũng trả 404', async () => {
    const patched = await request(app)
      .patch(`/api/v1/listings/${orgB.listingId}`)
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ price: 1 })
    expect(patched.status).toBe(404)

    const deleted = await request(app)
      .delete(`/api/v1/listings/${orgB.listingId}`)
      .set('Authorization', `Bearer ${orgA.token}`)
    expect(deleted.status).toBe(404)
  })

  it('login phải chỉ ra org, và trả đúng tài khoản của org đó', async () => {
    const withoutOrg = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: SHARED_EMAIL, password: PASSWORD })
    expect(withoutOrg.status).toBe(401)

    const scoped = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'org-b', email: SHARED_EMAIL, password: PASSWORD })
    expect(scoped.status).toBe(200)
    expect(scoped.body.data.user.id).toBe(orgB.ownerId)
  })
})

describe('Chain: đọc xuyên org, ghi thì không', () => {
  let adminToken = ''
  let chainId = ''

  beforeAll(async () => {
    const { PlatformAdmin } = await import('../../src/features/platform-admin/platform-admin.model')
    await PlatformAdmin.create({
      email: 'admin@platform.local',
      name: 'Super',
      password: 'platform123',
      role: 'super_admin',
    })

    const login = await request(app)
      .post('/platform-admin/auth/login')
      .send({ email: 'admin@platform.local', password: 'platform123' })
    expect(login.status).toBe(200)
    adminToken = login.body.data.accessToken

    const chain = await request(app)
      .post('/platform-admin/chains')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Hệ thống ABC', slug: 'abc-edu', ownerId: orgA.ownerId })
    expect(chain.status).toBe(201)
    chainId = chain.body.data._id

    for (const orgId of [orgA.orgId, orgB.orgId]) {
      const assigned = await request(app)
        .patch(`/platform-admin/organizations/${orgId}/chain`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ chainId })
      expect(assigned.status).toBe(200)
    }
  }, 60_000)

  it('token user KHÔNG dùng được cho route platform-admin', async () => {
    const res = await request(app)
      .post('/platform-admin/chains')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ name: 'x', ownerId: orgA.ownerId })
    expect(res.status).toBe(401)
  })

  it('user trong chain thấy tin của mọi org cùng chain trên chính GET /listings', async () => {
    const res = await request(app)
      .get('/api/v1/listings')
      .set('Authorization', `Bearer ${orgA.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('nhìn thấy không đồng nghĩa với sửa được: tin org khác vẫn 403', async () => {
    const res = await request(app)
      .patch(`/api/v1/listings/${orgB.listingId}`)
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ price: 1 })
    expect(res.status).toBe(403)

    const untouched = await request(app)
      .get(`/api/v1/listings/${orgB.listingId}`)
      .set('Authorization', `Bearer ${orgB.token}`)
    expect(untouched.body.data.price).toBe(1000000)
  })

  it('chain owner ghi tin mới thì tin rơi vào org của chính họ, không phải org khác', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send(listingPayload('Tin do chain owner tạo'))

    expect(res.status).toBe(201)
    // Scope đọc là cả chain, nhưng ghi vẫn rơi đúng org của người ghi.
    expect(res.body.data.organizationId).toBe(orgA.orgId)
  })

  it('thống kê chain gộp đủ hai org', async () => {
    const res = await request(app)
      .get(`/api/v1/chains/${chainId}/stats`)
      .set('Authorization', `Bearer ${orgA.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.organizations).toBe(2)
    expect(res.body.data.totals.listings).toBe(3)
  })

  it('không phải chủ chain thì 403', async () => {
    const res = await request(app)
      .get(`/api/v1/chains/${chainId}/stats`)
      .set('Authorization', `Bearer ${orgB.token}`)
    expect(res.status).toBe(403)
  })

  it('thông báo cấp chain fan-out mỗi org một bản ghi riêng', async () => {
    const sent = await request(app)
      .post(`/api/v1/chains/${chainId}/notifications`)
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ title: 'Thông báo chain', body: 'Nội dung' })
    expect(sent.status).toBe(201)
    expect(sent.body.data.organizations).toBe(2)

    for (const org of [orgA, orgB]) {
      const inbox = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${org.token}`)
      expect(inbox.body.data).toHaveLength(1)
      expect(inbox.body.data[0].sourceType).toBe('chain')
    }
  })

  it('suspend organization có hiệu lực ngay, không đợi access token hết hạn', async () => {
    const suspended = await request(app)
      .patch(`/platform-admin/organizations/${orgB.orgId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'suspended' })
    expect(suspended.status).toBe(200)

    const res = await request(app)
      .get('/api/v1/listings')
      .set('Authorization', `Bearer ${orgB.token}`)
    expect(res.status).toBe(403)
  })
})
