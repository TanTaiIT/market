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
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let member: TestUser
let solo: TestUser
let categoryId = ''
const SLUG = 'scope-org'

const asMember = () => orgAuth(member.token, SLUG)
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory()

  const master = await makeMaster(app)
  const owner = await registerUser(app, 'owner@scope.local', 'Owner')
  const org = await createOrg(app, master.token, {
    name: 'Scope Org',
    slug: SLUG,
    ownerEmail: owner.email,
    provinceCode: 'Hồ Chí Minh',
  })

  member = await registerUser(app, 'member@scope.local', 'Member')
  await addMember(member.id, org.id)
  solo = await registerUser(app, 'solo@scope.local', 'Solo')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

/**
 * Hai vế đọc của trục org và trục danh mục được ghép bằng `$or`. Nếu ghép bằng `.where()` thì
 * nó ĐÈ LÊN `$or` mà repository dùng cho `?q=`, và bộ lọc tìm kiếm biến mất không một tiếng
 * động — 171 test trước đó vẫn xanh trong khi tìm kiếm trả về mọi thứ.
 */
describe('Bộ lọc của repository sống chung được với scope hai trục', () => {
  it('?q= vẫn lọc đúng, không bị scope nuốt mất', async () => {
    const guitar = await request(app)
      .post('/api/v1/listings')
      .set(asMember())
      .send(listingPayload('Đàn guitar gỗ thông', categoryId))
      .expect(201)
    const bike = await request(app)
      .post('/api/v1/listings')
      .set(asMember())
      .send(listingPayload('Xe đạp thể thao', categoryId))
      .expect(201)
    await publishListing(guitar.body.data._id)
    await publishListing(bike.body.data._id)

    const res = await request(app).get('/api/v1/listings?q=guitar').set(asMember()).expect(200)

    const titles = res.body.data.map((l: { title: string }) => l.title)
    expect(titles).toEqual(['Đàn guitar gỗ thông'])
  })

  it('lọc theo khoảng giá cũng vậy — và vẫn không thấy tin org khác', async () => {
    const res = await request(app).get('/api/v1/listings?maxPrice=1').set(asMember()).expect(200)
    expect(res.body.data).toHaveLength(0)
  })
})

/**
 * "Tin của tôi" phải hẹp theo NGƯỜI ĐĂNG, không theo trục: người không thuộc tổ chức nào đăng
 * tin công khai xong mà màn này rỗng thì đúng bằng cảm giác đăng hụt.
 */
describe('GET /listings/mine bám theo người đăng, không theo trục', () => {
  it('người không thuộc org nào thấy tin công khai đang chờ duyệt của mình', async () => {
    const created = await request(app)
      .post('/api/v1/listings')
      .set(bearer(solo))
      .send({
        ...listingPayload('Tin trục danh mục chờ duyệt', categoryId),
        visibility: 'public',
        provinceCode: 'Hồ Chí Minh',
      })
      .expect(201)
    expect(created.body.data.organizationId).toBeNull()

    const mine = await request(app).get('/api/v1/listings/mine').set(bearer(solo)).expect(200)
    expect(mine.body.data.map((l: { _id: string }) => l._id)).toContain(created.body.data._id)
  })

  it('vẫn chỉ thấy tin của CHÍNH mình, không thấy của người khác', async () => {
    const mine = await request(app).get('/api/v1/listings/mine').set(bearer(solo)).expect(200)
    const titles = mine.body.data.map((l: { title: string }) => l.title)
    expect(titles).not.toContain('Đàn guitar gỗ thông')
  })

  it('thành viên org vẫn thấy tin nội bộ đang chờ duyệt của mình', async () => {
    const created = await request(app)
      .post('/api/v1/listings')
      .set(asMember())
      .send(listingPayload('Tin nội bộ chờ duyệt', categoryId))
      .expect(201)

    const mine = await request(app).get('/api/v1/listings/mine').set(asMember()).expect(200)
    expect(mine.body.data.map((l: { _id: string }) => l._id)).toContain(created.body.data._id)
  })
})

describe('Tra quota không cần categoryId', () => {
  it('không có categoryId thì trả bậc mặc định thay vì 500', async () => {
    const res = await request(app).get('/api/v1/listings/quota').set(bearer(solo))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ allowed: expect.any(Boolean), limit: expect.any(Number) })
  })
})
