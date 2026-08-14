import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

/** Token của super_admin — mọi thao tác ghi danh mục đều đi qua nhánh /platform-admin. */
let superToken: string
/** Token của support — dùng để chứng minh vai này KHÔNG ghi được. */
let supportToken: string
/** Token của một user thường trong org, để thử tạo tin. */
let userToken: string

const SUPER = { email: 'super@platform.local', password: 'platform123' }
const SUPPORT = { email: 'support@platform.local', password: 'platform123' }

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const uri = mongod.getUri()
  process.env.MONGO_URI = uri
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(uri)

  const { createApp } = await import('../../src/app')
  app = createApp()

  const { PlatformAdmin } = await import('../../src/features/platform-admin/platform-admin.model')
  const { PLATFORM_ADMIN_ROLES } = await import('../../src/common/constants')
  await PlatformAdmin.create([
    { ...SUPER, name: 'Super', role: PLATFORM_ADMIN_ROLES.SUPER_ADMIN },
    { ...SUPPORT, name: 'Support', role: PLATFORM_ADMIN_ROLES.SUPPORT },
  ])

  const login = (body: typeof SUPER) =>
    request(app).post('/platform-admin/auth/login').send(body).expect(200)

  superToken = (await login(SUPER)).body.data.accessToken
  supportToken = (await login(SUPPORT)).body.data.accessToken

  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      organizationName: 'Cat Org',
      organizationSlug: 'cat-org',
      name: 'Cat Owner',
      email: 'owner@cat-org.local',
      password: 'password123',
    })
    .expect(201)
  userToken = registered.body.data.tokens.accessToken
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const asSuper = () => ({ Authorization: `Bearer ${superToken}` })

describe('Category — đọc công khai', () => {
  let activeId: string
  let inactiveId: string

  it('super_admin tạo được danh mục, slug tự sinh từ tên', async () => {
    const res = await request(app)
      .post('/platform-admin/categories')
      .set(asSuper())
      .send({ name: 'Sách vở', icon: '📚', order: 1 })

    expect(res.status).toBe(201)
    expect(res.body.data.slug).toBe('sach-vo')
    expect(res.body.data.isActive).toBe(true)
    activeId = res.body.data.id
  })

  it('chặn slug trùng bằng 409, không để rơi xuống lỗi duplicate key của Mongo', async () => {
    const res = await request(app)
      .post('/platform-admin/categories')
      .set(asSuper())
      .send({ name: 'Sách  vở' }) // slugify ra cùng 'sach-vo'
    expect(res.status).toBe(409)
  })

  it('support KHÔNG ghi được danh mục', async () => {
    const res = await request(app)
      .post('/platform-admin/categories')
      .set({ Authorization: `Bearer ${supportToken}` })
      .send({ name: 'Đồ dùng' })
    expect(res.status).toBe(403)
  })

  it('không có token platform-admin thì không ghi được', async () => {
    const res = await request(app).post('/platform-admin/categories').send({ name: 'Xe đạp' })
    expect(res.status).toBe(401)
  })

  it('token user thường KHÔNG dùng được cho nhánh platform-admin', async () => {
    const res = await request(app)
      .post('/platform-admin/categories')
      .set({ Authorization: `Bearer ${userToken}` })
      .send({ name: 'Xe đạp' })
    expect(res.status).toBe(401)
  })

  it('GET /categories mặc định chỉ trả danh mục đang bật', async () => {
    const created = await request(app)
      .post('/platform-admin/categories')
      .set(asSuper())
      .send({ name: 'Đã ngừng', order: 9 })
      .expect(201)
    inactiveId = created.body.data.id

    await request(app)
      .patch(`/platform-admin/categories/${inactiveId}`)
      .set(asSuper())
      .send({ isActive: false })
      .expect(200)

    const res = await request(app).get('/api/v1/categories').expect(200)
    const ids = res.body.data.map((c: { id: string }) => c.id)
    expect(ids).toContain(activeId)
    expect(ids).not.toContain(inactiveId)
  })

  it('includeInactive=true mới thấy danh mục đã tắt', async () => {
    const res = await request(app).get('/api/v1/categories?includeInactive=true').expect(200)
    const ids = res.body.data.map((c: { id: string }) => c.id)
    expect(ids).toContain(inactiveId)
  })

  it('GET /categories/:id không tồn tại trả 404', async () => {
    const res = await request(app).get(`/api/v1/categories/${new Types.ObjectId().toString()}`)
    expect(res.status).toBe(404)
  })

  it('GET /categories/:id sai định dạng trả 400', async () => {
    const res = await request(app).get('/api/v1/categories/khong-phai-objectid')
    expect(res.status).toBe(400)
  })

  it('DTO không lộ field nội bộ', async () => {
    const res = await request(app).get('/api/v1/categories').expect(200)
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['icon', 'id', 'isActive', 'name', 'order', 'slug'].sort(),
    )
  })
})

const listingBody = (categoryId: string) => ({
  title: 'Xe đạp thể thao còn mới',
  description: 'Mô tả đủ dài cho zod schema đi qua',
  price: 250000,
  categoryId,
  images: ['https://example.com/a.jpg'],
  location: { coordinates: [106.7, 10.77] as [number, number], province: 'Hồ Chí Minh' },
})

describe('Listing — ràng buộc categoryId', () => {
  it('từ chối categoryId đúng 24 hex nhưng không trỏ tới danh mục nào', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send(listingBody(new Types.ObjectId().toString()))

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Danh mục/)
  })

  it('chấp nhận danh mục đang bật', async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send(listingBody(categories.body.data[0].id))

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
  })

  it('từ chối danh mục đã tắt — tin mới không được gắn vào danh mục ngừng lưu thông', async () => {
    const all = await request(app).get('/api/v1/categories?includeInactive=true').expect(200)
    const off = all.body.data.find((c: { isActive: boolean }) => !c.isActive)

    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send(listingBody(off.id))

    expect(res.status).toBe(400)
  })
})

describe('Listing — toạ độ là tuỳ chọn', () => {
  const activeCategoryId = async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    return categories.body.data[0].id as string
  }

  it('tạo được tin khi bỏ trống location — app chưa có bản đồ để lấy toạ độ', async () => {
    const body: Record<string, unknown> = listingBody(await activeCategoryId())
    delete body.location

    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send(body)

    expect(res.status).toBe(201)
    // Phải VẮNG hẳn, không phải `{ type: 'Point' }` rỗng coordinates: subdoc nửa vời sẽ lọt
    // vào index 2dsphere và làm $near trả rác.
    expect(res.body.data.location).toBeUndefined()
  })

  it('vẫn từ chối toạ độ sai ngưỡng — optional chỉ cho phép VẮNG, không cho phép sai', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send({
        ...listingBody(await activeCategoryId()),
        // Vĩ độ 999 vượt ngưỡng 90. Đây cũng là hình dạng của lỗi đảo [lat, lng] thành [lng, lat].
        location: { coordinates: [106.7, 999] },
      })

    expect(res.status).toBe(400)
  })
})

describe('GET /listings/mine — chủ tin thấy tin đang chờ duyệt', () => {
  it('trả tin pending mà /listings công khai giấu đi', async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    const created = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .send(listingBody(categories.body.data[0].id))
      .expect(201)

    const id = created.body.data._id
    expect(created.body.data.status).toBe('pending')

    const mine = await request(app)
      .get('/api/v1/listings/mine')
      .set({ Authorization: `Bearer ${userToken}` })
      .expect(200)
    expect(mine.body.data.map((l: { _id: string }) => l._id)).toContain(id)

    // Cùng lúc đó danh sách công khai vẫn phải giấu nó — /mine không được nới lỏng chỗ này.
    const publicList = await request(app)
      .get('/api/v1/listings')
      .set({ Authorization: `Bearer ${userToken}` })
      .expect(200)
    expect(publicList.body.data.map((l: { _id: string }) => l._id)).not.toContain(id)
  })

  it('đòi token — chủ tin lấy từ access token nên không thể xem trộm bằng query', async () => {
    await request(app).get('/api/v1/listings/mine').expect(401)
  })

  it('không bị nuốt thành /listings/:id — route phải khai trước', async () => {
    const res = await request(app)
      .get('/api/v1/listings/mine')
      .set({ Authorization: `Bearer ${userToken}` })
    // Rơi vào `/:id` thì validate ObjectId sẽ ném 400 vì "mine" không phải 24 hex.
    expect(res.status).not.toBe(400)
  })
})
