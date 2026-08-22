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
let orgHeaders: Record<string, string>

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

  const { makeMaster, registerUser, createOrg, orgAuth, setTrustLevel } =
    await import('../helpers/fixtures')

  const master = await makeMaster(app, SUPER.email)
  superToken = master.token

  // "support" của v1 giờ chỉ là một tài khoản KHÔNG có grant master — chính là bằng chứng
  // rằng quyền ghi danh mục đến từ `role_grants`, không từ việc đăng nhập ở nhánh nào.
  supportToken = (await registerUser(app, SUPPORT.email, 'Support')).token

  const owner = await registerUser(app, 'owner@cat-org.local', 'Cat Owner')
  const org = await createOrg(app, superToken, {
    name: 'Cat Org',
    slug: 'cat-org',
    ownerEmail: owner.email,
  })
  orgHeaders = orgAuth(owner.token, org.slug)
  // File test này đăng nhiều tin liên tiếp để thử ràng buộc danh mục; quota mặc định (3 tin
  // chờ) sẽ chặn ngang giữa chừng và che mất thứ đang thực sự được kiểm.
  await setTrustLevel(owner.id, 1)
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
      .post('/api/v1/categories')
      .set(asSuper())
      .send({ name: 'Sách vở', icon: '📚', order: 1 })

    expect(res.status).toBe(201)
    expect(res.body.data.slug).toBe('sach-vo')
    expect(res.body.data.isActive).toBe(true)
    activeId = res.body.data.id
  })

  it('chặn slug trùng bằng 409, không để rơi xuống lỗi duplicate key của Mongo', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(asSuper())
      .send({ name: 'Sách  vở' }) // slugify ra cùng 'sach-vo'
    expect(res.status).toBe(409)
  })

  it('support KHÔNG ghi được danh mục', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set({ Authorization: `Bearer ${supportToken}` })
      .send({ name: 'Đồ dùng' })
    expect(res.status).toBe(403)
  })

  it('không có token master thì không ghi được', async () => {
    const res = await request(app).post('/api/v1/categories').send({ name: 'Xe đạp' })
    expect(res.status).toBe(401)
  })

  it('token user thường KHÔNG ghi được danh mục — thiếu grant master', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(orgHeaders)
      .send({ name: 'Xe đạp' })
    expect(res.status).toBe(403)
  })

  it('GET /categories mặc định chỉ trả danh mục đang bật', async () => {
    const created = await request(app)
      .post('/api/v1/categories')
      .set(asSuper())
      .send({ name: 'Đã ngừng', order: 9 })
      .expect(201)
    inactiveId = created.body.data.id

    await request(app)
      .patch(`/api/v1/categories/${inactiveId}`)
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
    // `requireManualReview` công khai có chủ ý: bàn quản trị đọc nó từ chính endpoint này để
    // bật/tắt, và với người đăng thì nó là lời hứa "tin ở đây luôn có người xem", không phải
    // bí mật vận hành. `deletedAt`/`createdAt`/`updatedAt`/`_id` vẫn phải nằm ngoài.
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['icon', 'id', 'isActive', 'name', 'order', 'requireManualReview', 'slug'].sort(),
    )
  })
})

const listingBody = (categoryId: string) => ({
  title: 'Xe đạp thể thao còn mới',
  description: 'Mô tả đủ dài cho zod schema đi qua',
  price: 250000,
  categoryId,
  images: ['https://example.com/a.jpg'],
  location: { province: 'Hồ Chí Minh' as const, ward: 'Phường Bến Thành' },
})

describe('Listing — ràng buộc categoryId', () => {
  it('từ chối categoryId đúng 24 hex nhưng không trỏ tới danh mục nào', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(listingBody(new Types.ObjectId().toString()))

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Danh mục/)
  })

  it('chấp nhận danh mục đang bật', async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(listingBody(categories.body.data[0].id))

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
  })

  it('từ chối danh mục đã tắt — tin mới không được gắn vào danh mục ngừng lưu thông', async () => {
    const all = await request(app).get('/api/v1/categories?includeInactive=true').expect(200)
    const off = all.body.data.find((c: { isActive: boolean }) => !c.isActive)

    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(listingBody(off.id))

    expect(res.status).toBe(400)
  })
})

describe('Listing — khu vực là tuỳ chọn, và không còn toạ độ', () => {
  const activeCategoryId = async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    return categories.body.data[0].id as string
  }

  it('tạo được tin khi bỏ trống location — người đăng không bắt buộc khai khu vực', async () => {
    const body: Record<string, unknown> = listingBody(await activeCategoryId())
    delete body.location

    const res = await request(app).post('/api/v1/listings').set(orgHeaders).send(body)

    expect(res.status).toBe(201)
    // Phải VẮNG hẳn chứ không phải subdoc rỗng: tin không khai khu vực và tin khai rỗng phải
    // là cùng một thứ khi lọc theo tỉnh.
    expect(res.body.data.location).toBeUndefined()
  })

  it('lưu đúng tỉnh + xã đã gửi', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(listingBody(await activeCategoryId()))

    expect(res.status).toBe(201)
    expect(res.body.data.location).toMatchObject({
      province: 'Hồ Chí Minh',
      ward: 'Phường Bến Thành',
    })
  })

  it('từ chối `coordinates` — geo đã bỏ hẳn, client bản cũ phải nhận 400 thay vì bị cắt im lặng', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send({
        ...listingBody(await activeCategoryId()),
        location: { province: 'Hồ Chí Minh', coordinates: [106.7, 10.77] },
      })

    expect(res.status).toBe(400)
  })

  it('từ chối tỉnh ngoài danh sách 34 đơn vị', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send({
        ...listingBody(await activeCategoryId()),
        location: { province: 'Bình Dương' },
      })

    expect(res.status).toBe(400)
  })
})

describe('GET /listings/mine — chủ tin thấy tin đang chờ duyệt', () => {
  it('trả tin pending mà /listings công khai giấu đi', async () => {
    const categories = await request(app).get('/api/v1/categories').expect(200)
    const created = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(listingBody(categories.body.data[0].id))
      .expect(201)

    const id = created.body.data._id
    expect(created.body.data.status).toBe('pending')

    const mine = await request(app).get('/api/v1/listings/mine').set(orgHeaders).expect(200)
    expect(mine.body.data.map((l: { _id: string }) => l._id)).toContain(id)

    // Cùng lúc đó danh sách công khai vẫn phải giấu nó — /mine không được nới lỏng chỗ này.
    const publicList = await request(app).get('/api/v1/listings').set(orgHeaders).expect(200)
    expect(publicList.body.data.map((l: { _id: string }) => l._id)).not.toContain(id)
  })

  it('đòi token — chủ tin lấy từ access token nên không thể xem trộm bằng query', async () => {
    await request(app).get('/api/v1/listings/mine').expect(401)
  })

  it('không bị nuốt thành /listings/:id — route phải khai trước', async () => {
    const res = await request(app).get('/api/v1/listings/mine').set(orgHeaders)
    // Rơi vào `/:id` thì validate ObjectId sẽ ném 400 vì "mine" không phải 24 hex.
    expect(res.status).not.toBe(400)
  })
})
