import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  orgIdOf,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

/**
 * `GET /moderation/listings?seller=` — màn Người dùng › chi tiết của master: MỌI tin một người
 * đã đăng, mọi trạng thái bàn duyệt thấy được. Là bộ lọc trên scope sẵn có, nên quản trị nhóm
 * dùng cùng tham số chỉ thấy phần của người đó trong nhóm mình.
 */
let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let ownerA: TestUser
let ownerB: TestUser
let seller: TestUser
let other: TestUser
let categoryId = ''
const ORG_A = 'nhom-seller-a'
const ORG_B = 'nhom-seller-b'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const titlesOf = (res: { body: { data: { title: string }[] } }) =>
  res.body.data.map((l) => l.title).sort()

async function post(who: TestUser, org: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, org))
    .send({ ...listingPayload(title, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data._id as string
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung-seller')
  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner-a@seller.local', 'Chủ nhóm A')
  ownerB = await registerUser(app, 'owner-b@seller.local', 'Chủ nhóm B')
  seller = await registerUser(app, 'seller@seller.local', 'Người bán cần xem')
  other = await registerUser(app, 'other@seller.local', 'Người khác')
  await createOrg(app, master.token, { name: 'Nhóm A', key: ORG_A, ownerEmail: ownerA.email })
  await createOrg(app, master.token, { name: 'Nhóm B', key: ORG_B, ownerEmail: ownerB.email })
  await addMember(seller.id, orgIdOf(ORG_A))
  await addMember(seller.id, orgIdOf(ORG_B))
  await addMember(other.id, orgIdOf(ORG_A))
  // Bậc 1: tin vào hàng đợi — cần tin ở nhiều trạng thái khác nhau.
  await setTrustLevel(seller.id, 1)
  await setTrustLevel(other.id, 1)

  const approved = await post(seller, ORG_A, 'Tin A đã duyệt')
  const rejected = await post(seller, ORG_A, 'Tin A bị từ chối')
  await post(seller, ORG_B, 'Tin B đang chờ')
  await post(other, ORG_A, 'Tin của người khác')

  await request(app)
    .patch(`/api/v1/moderation/listings/${approved}`)
    .set(orgAuth(ownerA.token, ORG_A))
    .send({ status: 'active' })
    .expect(200)
  await request(app)
    .patch(`/api/v1/moderation/listings/${rejected}`)
    .set(orgAuth(ownerA.token, ORG_A))
    .send({ status: 'rejected', reason: 'Ảnh không đúng món hàng', severity: 'quality' })
    .expect(200)

  // Một tin trục công khai của cùng người (không thuộc nhóm nào) — master phải thấy cả nó.
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test fixture: tin trục công khai', () =>
    Listing.create({
      organizationId: null,
      reach: 'marketplace',
      provinceCode: 'Hồ Chí Minh',
      wardCode: 'Phường Bến Thành',
      title: 'Tin công khai của người bán',
      description: 'Mô tả đủ dài cho zod schema đi qua được',
      price: 120000,
      category: categoryId,
      seller: seller.id,
      posterName: 'Người bán cần xem',
      status: 'pending',
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    }),
  )
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Bàn duyệt — lọc theo người đăng', () => {
  it('master: mọi tin của người đó, ở mọi nhóm và trục công khai, đủ các trạng thái', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .query({ seller: seller.id })
      .set(bearer(master))
      .expect(200)

    expect(titlesOf(res)).toEqual(
      [
        'Tin A bị từ chối',
        'Tin A đã duyệt',
        'Tin B đang chờ',
        'Tin công khai của người bán',
      ].sort(),
    )
    const statuses = new Set(res.body.data.map((l: { status: string }) => l.status))
    expect([...statuses].sort()).toEqual(['active', 'pending', 'rejected'])
  }, 60_000)

  it('kèm `status` thì thu hẹp tiếp', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .query({ seller: seller.id, status: 'rejected' })
      .set(bearer(master))
      .expect(200)
    expect(titlesOf(res)).toEqual(['Tin A bị từ chối'])
  }, 60_000)

  it('quản trị nhóm A: chỉ phần của người đó TRONG nhóm A — bộ lọc không mở rộng scope', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .query({ seller: seller.id })
      .set(orgAuth(ownerA.token, ORG_A))
      .expect(200)
    expect(titlesOf(res)).toEqual(['Tin A bị từ chối', 'Tin A đã duyệt'].sort())
  }, 60_000)

  it('id người đăng sai định dạng → 400', async () => {
    await request(app)
      .get('/api/v1/moderation/listings')
      .query({ seller: 'khong-phai-id' })
      .set(bearer(master))
      .expect(400)
  }, 60_000)
})
