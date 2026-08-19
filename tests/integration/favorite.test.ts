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

let master: TestUser
let owner: TestUser
let member: TestUser
/** Người mua KHÔNG thuộc org nào — ca chính khiến `Favorite` phải đứng ngoài `tenantPlugin`. */
let buyer: TestUser
let categoryId = ''

const SLUG = 'fav-org'

/** Tin công khai, đã duyệt — ai cũng đọc được. */
let publicListing = ''
/** Tin nội bộ của org, người ngoài không đọc được. */
let internalListing = ''

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function createListing(headers: Record<string, string>, title: string, visibility: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(headers)
    .send({ ...listingPayload(title, categoryId), visibility })
    .expect(201)
  return res.body.data._id as string
}

/** Số lượt lưu đang ghi trên chính tin — đọc thẳng model để không phụ thuộc scope của ai. */
async function favoriteCountOf(listingId: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const doc = await runUnscoped('test assertion', () =>
    Listing.findById(listingId).select('favoriteCount').lean().exec(),
  )
  return doc?.favoriteCount
}

const savedIds = (token: string) =>
  request(app).get('/api/v1/favorites/ids').set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ điện tử', 'do-dien-tu')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@fav.local', 'Owner')
  const org = await createOrg(app, master.token, {
    name: 'Tổ chức Favorite',
    slug: SLUG,
    ownerEmail: owner.email,
  })

  member = await registerUser(app, 'member@fav.local', 'Thành viên')
  await addMember(member.id, org.id)
  buyer = await registerUser(app, 'buyer@fav.local', 'Người mua')

  publicListing = await createListing(
    orgAuth(member.token, SLUG),
    'Bàn phím cơ còn bảo hành',
    'public',
  )
  await publishListing(publicListing)

  internalListing = await createListing(
    orgAuth(member.token, SLUG),
    'Tủ tài liệu nội bộ',
    'org_internal',
  )
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Favorite — lưu và bỏ lưu', () => {
  it('người không thuộc org nào vẫn lưu được tin công khai', async () => {
    const res = await request(app).post(`/api/v1/favorites/${publicListing}`).set(bearer(buyer))

    expect(res.status).toBe(201)
    expect(res.body.data).toEqual({ listingId: publicListing, favorited: true })
    expect(await favoriteCountOf(publicListing)).toBe(1)
  })

  it('id vừa lưu có trong danh sách id', async () => {
    const res = await savedIds(buyer.token).expect(200)
    expect(res.body.data).toEqual([publicListing])
  })

  it('bấm tim lần hai không tạo thêm bản ghi và không cộng thêm bộ đếm', async () => {
    const res = await request(app).post(`/api/v1/favorites/${publicListing}`).set(bearer(buyer))

    expect(res.status).toBe(201)
    expect(res.body.data.favorited).toBe(true)
    expect((await savedIds(buyer.token)).body.data).toHaveLength(1)
    expect(await favoriteCountOf(publicListing)).toBe(1)
  })

  it('danh sách tin đã lưu trả về nguyên tin, kèm meta phân trang', async () => {
    const res = await request(app).get('/api/v1/favorites').set(bearer(buyer)).expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]._id).toBe(publicListing)
    expect(res.body.data[0].title).toBe('Bàn phím cơ còn bảo hành')
    expect(res.body.meta).toMatchObject({ page: 1, total: 1, totalPages: 1 })
  })

  it('bỏ lưu trả bộ đếm về 0 và làm rỗng danh sách', async () => {
    const res = await request(app).delete(`/api/v1/favorites/${publicListing}`).set(bearer(buyer))

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ listingId: publicListing, favorited: false })
    expect((await savedIds(buyer.token)).body.data).toEqual([])
    expect(await favoriteCountOf(publicListing)).toBe(0)
  })

  it('bỏ lưu lần hai vẫn 200 và KHÔNG kéo bộ đếm xuống âm', async () => {
    await request(app).delete(`/api/v1/favorites/${publicListing}`).set(bearer(buyer)).expect(200)
    expect(await favoriteCountOf(publicListing)).toBe(0)
  })
})

describe('Favorite — phạm vi và lỗi', () => {
  it('không lưu được tin nội bộ của org mình không thuộc → 404', async () => {
    const res = await request(app).post(`/api/v1/favorites/${internalListing}`).set(bearer(buyer))

    expect(res.status).toBe(404)
    expect((await savedIds(buyer.token)).body.data).toEqual([])
  })

  it('thành viên của chính org đó thì lưu được tin nội bộ', async () => {
    const res = await request(app)
      .post(`/api/v1/favorites/${internalListing}`)
      .set(orgAuth(member.token, SLUG))

    expect(res.status).toBe(201)
    expect((await savedIds(member.token)).body.data).toEqual([internalListing])
  })

  it('tin không tồn tại → 404', async () => {
    const ghost = new mongoose.Types.ObjectId().toString()
    await request(app).post(`/api/v1/favorites/${ghost}`).set(bearer(buyer)).expect(404)
  })

  it('id sai định dạng → 400', async () => {
    await request(app).post('/api/v1/favorites/khong-phai-objectid').set(bearer(buyer)).expect(400)
  })

  it('chưa đăng nhập → 401 ở cả đường đọc lẫn đường ghi', async () => {
    await request(app).get('/api/v1/favorites').expect(401)
    await request(app).get('/api/v1/favorites/ids').expect(401)
    await request(app).post(`/api/v1/favorites/${publicListing}`).expect(401)
    await request(app).delete(`/api/v1/favorites/${publicListing}`).expect(401)
  })
})

describe('Favorite — tin bị gỡ sau khi đã lưu', () => {
  let removed = ''

  beforeAll(async () => {
    removed = await createListing(orgAuth(member.token, SLUG), 'Ghế công thái học', 'public')
    await publishListing(removed)
    await request(app).post(`/api/v1/favorites/${removed}`).set(bearer(buyer)).expect(201)
    await request(app)
      .delete(`/api/v1/listings/${removed}`)
      .set(orgAuth(member.token, SLUG))
      .expect(200)
  })

  it('tin đã gỡ rơi khỏi `data` nhưng `meta.total` vẫn đếm bản ghi đã lưu', async () => {
    const res = await request(app).get('/api/v1/favorites').set(bearer(buyer)).expect(200)

    expect(res.body.data).toEqual([])
    expect(res.body.meta.total).toBe(1)
  })

  it('vẫn bỏ lưu được tin đã gỡ — không ai bị kẹt với bản ghi không xoá nổi', async () => {
    await request(app).delete(`/api/v1/favorites/${removed}`).set(bearer(buyer)).expect(200)
    expect((await savedIds(buyer.token)).body.data).toEqual([])
  })
})
