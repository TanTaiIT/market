import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  PASSWORD,
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  publishListing,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let CATEGORY_ID = ''
let master: TestUser
const orgA = { id: '', slug: 'org-a', owner: {} as TestUser, listingId: '' }
const orgB = { id: '', slug: 'org-b', owner: {} as TestUser, listingId: '' }

async function createListing(user: TestUser, orgSlug: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(user.token, orgSlug))
    .send(listingPayload(title, CATEGORY_ID))
    .expect(201)
  return res.body.data._id as string
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  CATEGORY_ID = await createCategory()
  master = await makeMaster(app)

  orgA.owner = await registerUser(app, 'owner@org-a.local', 'Owner A')
  orgB.owner = await registerUser(app, 'owner@org-b.local', 'Owner B')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(orgA.owner.id, 0)
  await setTrustLevel(orgB.owner.id, 0)

  orgA.id = (
    await createOrg(app, master.token, {
      name: 'Org A',
      slug: orgA.slug,
      ownerEmail: orgA.owner.email,
    })
  ).id
  orgB.id = (
    await createOrg(app, master.token, {
      name: 'Org B',
      slug: orgB.slug,
      ownerEmail: orgB.owner.email,
    })
  ).id

  orgA.listingId = await createListing(orgA.owner, orgA.slug, 'Tin đăng của org A')
  orgB.listingId = await createListing(orgB.owner, orgB.slug, 'Tin đăng của org B')
  await publishListing(orgA.listingId)
  await publishListing(orgB.listingId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Cách ly giữa hai org', () => {
  it('GET /listings chỉ trả tin của org đang hoạt động', async () => {
    const res = await request(app).get('/api/v1/listings').set(orgAuth(orgA.owner.token, orgA.slug))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]._id).toBe(orgA.listingId)
  })

  it('đọc tin org khác trả 404 chứ không phải 403 — không lộ sự tồn tại', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.slug))
    expect(res.status).toBe(404)
  })

  it('sửa và xoá tin org khác cũng trả 404', async () => {
    const patched = await request(app)
      .patch(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.slug))
      .send({ price: 1 })
    expect(patched.status).toBe(404)

    const deleted = await request(app)
      .delete(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.slug))
    expect(deleted.status).toBe(404)
  })

  it('ghi tin mới luôn rơi vào org đang hoạt động', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(orgA.owner.token, orgA.slug))
      .send(listingPayload('Tin mới của org A', CATEGORY_ID))

    expect(res.status).toBe(201)
    expect(res.body.data.organizationId).toBe(orgA.id)
  })
})

describe('Org hoạt động đến từ request, không từ token', () => {
  it('một tài khoản thuộc HAI org, chỉ ra org nào thì thấy dữ liệu org đó', async () => {
    const nomad = await registerUser(app, 'nomad@example.com', 'Người hai nơi')
    await addMember(nomad.id, orgA.id)
    await addMember(nomad.id, orgB.id)

    const inA = await request(app).get('/api/v1/listings').set(orgAuth(nomad.token, orgA.slug))
    const inB = await request(app).get('/api/v1/listings').set(orgAuth(nomad.token, orgB.slug))

    expect(inA.body.data[0]._id).toBe(orgA.listingId)
    expect(inB.body.data[0]._id).toBe(orgB.listingId)
  })

  it('không thuộc org thì KHÔNG ghi được vào org đó', async () => {
    const outsider = await registerUser(app, 'outsider@example.com', 'Người ngoài')

    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(outsider.token, orgA.slug))
      .send(listingPayload('Tin của người ngoài', CATEGORY_ID))

    // Không mở scope -> tenantPlugin fail-closed chặn ở tầng thấp nhất.
    expect(res.status).toBe(400)
  })

  it('rời org là mất quyền NGAY, không đợi token hết hạn', async () => {
    const leaver = await registerUser(app, 'leaver@example.com', 'Người rời đi')
    await addMember(leaver.id, orgA.id)

    const before = await request(app).get('/api/v1/listings').set(orgAuth(leaver.token, orgA.slug))
    expect(before.status).toBe(200)

    const { Membership } = await import('../../src/features/membership/membership.model')
    await Membership.updateOne(
      { userId: leaver.id, organizationId: orgA.id },
      { status: 'archived' },
    ).exec()

    // Cùng token đó, ghi không còn đi được nữa.
    const after = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(leaver.token, orgA.slug))
      .send(listingPayload('Tin sau khi rời org', CATEGORY_ID))
    expect(after.status).toBe(400)
  })
})

describe('Nhánh master', () => {
  it('user thường KHÔNG tạo được org', async () => {
    const res = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${orgA.owner.token}`)
      .send({ name: 'Org tự tạo', slug: 'org-tu-tao', ownerEmail: orgA.owner.email })
    expect(res.status).toBe(403)
  })

  it('chủ org nhận được quyền manager scope org của mình', async () => {
    const res = await request(app)
      .get('/api/v1/role-grants/mine')
      .set('Authorization', `Bearer ${orgA.owner.token}`)
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ role: 'manager', scopeType: 'org', orgId: orgA.id })
  })

  it('suspend organization có hiệu lực ngay', async () => {
    const suspended = await request(app)
      .patch(`/api/v1/organizations/${orgB.id}/status`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ status: 'suspended' })
    expect(suspended.status).toBe(200)

    const res = await request(app).get('/api/v1/listings').set(orgAuth(orgB.owner.token, orgB.slug))
    expect(res.status).toBe(403)
  })

  it('không thu hồi được master cuối cùng', async () => {
    const grants = await request(app)
      .get('/api/v1/role-grants/mine')
      .set('Authorization', `Bearer ${master.token}`)
      .expect(200)

    const masterGrantId = grants.body.data[0].id
    // Tự thu hồi quyền của chính mình đã bị chặn từ tầng policy.
    const res = await request(app)
      .delete(`/api/v1/role-grants/${masterGrantId}`)
      .set('Authorization', `Bearer ${master.token}`)
    expect(res.status).toBe(403)
  })
})

describe('Đăng nhập không còn phụ thuộc org', () => {
  it('cùng email không thể tồn tại ở hai org nữa — tài khoản là toàn cục', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Trùng', email: orgA.owner.email, password: PASSWORD })
    expect(res.status).toBe(409)
  })
})
