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
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let spammer: TestUser
let bystander: TestUser
let categoryId = ''
let spamListing = ''

const asMaster = () => ({ Authorization: `Bearer ${master.token}` })
const PASSWORD = 'password123'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  spammer = await registerUser(app, 'spam@user-admin.local', 'Kẻ spam')
  bystander = await registerUser(app, 'binh-thuong@user-admin.local', 'Người bình thường')

  // Tin công khai của spammer, đã lên bảng — thứ phải biến mất khi tài khoản bị khoá.
  const created = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${spammer.token}`)
    .send({
      ...listingPayload('Tin spam đang hiển thị', categoryId),
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  spamListing = created.body.data._id
  await publishListing(spamListing)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Bảng người dùng của master', () => {
  it('master thấy đủ danh sách, kèm email và trạng thái', async () => {
    const res = await request(app).get('/api/v1/users').set(asMaster()).expect(200)

    const spamRow = res.body.data.find((u: { email: string }) => u.email === spammer.email)
    expect(spamRow).toMatchObject({ isActive: true, trustLevel: 0 })
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3)
  })

  it('tìm theo tiền tố email', async () => {
    const res = await request(app).get('/api/v1/users?q=spam@').set(asMaster()).expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].email).toBe(spammer.email)
  })

  it('người thường không xem được bảng này', async () => {
    await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${bystander.token}`)
      .expect(403)
  })
})

describe('Khoá tài khoản', () => {
  it('khoá mà không nêu lý do thì bị chặn từ zod', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${spammer.id}/status`)
      .set(asMaster())
      .send({ isActive: false })

    expect(res.status).toBe(400)
  })

  it('khoá xong: đăng nhập chặn ngay, tin biến khỏi bảng, danh sách lọc ra đúng người', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${spammer.id}/status`)
      .set(asMaster())
      .send({ isActive: false, reason: 'Đăng hàng loạt tin trùng lặp' })

    expect(res.status).toBe(200)
    expect(res.body.data.isActive).toBe(false)

    // Đăng nhập chặn ngay lập tức.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: spammer.email, password: PASSWORD })
      .expect(401)

    // Tin đang hiển thị của họ đã bị ẩn khỏi bảng công khai.
    const board = await request(app).get('/api/v1/listings').expect(200)
    expect(board.body.data.map((l: { _id: string }) => l._id)).not.toContain(spamListing)

    const locked = await request(app).get('/api/v1/users?status=locked').set(asMaster()).expect(200)
    expect(locked.body.data.map((u: { email: string }) => u.email)).toEqual([spammer.email])
  })

  it('lý do khoá đến tay người bị khoá qua thông báo', async () => {
    // Access token đang sống vẫn đọc được hộp thư — đúng cửa sổ 15 phút đã chấp nhận,
    // và cũng là đường duy nhất để họ biết vì sao mình bị khoá.
    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${spammer.token}`)
      .expect(200)

    const lockNote = inbox.body.data.find(
      (n: { title: string }) => n.title === 'Tài khoản của bạn đã bị khoá',
    )
    expect(lockNote.body).toContain('tin trùng lặp')
  })

  it('khoá lại lần nữa thì 409 — trạng thái không đổi', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${spammer.id}/status`)
      .set(asMaster())
      .send({ isActive: false, reason: 'Khoá lần hai cho chắc' })

    expect(res.status).toBe(409)
  })

  it('master không tự khoá chính mình', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${master.id}/status`)
      .set(asMaster())
      .send({ isActive: false, reason: 'Tự khoá thử xem sao' })

    expect(res.status).toBe(400)
  })

  it('không khoá được người đang giữ quyền master', async () => {
    const second = await makeMaster(app, 'master2@user-admin.local')
    const res = await request(app)
      .patch(`/api/v1/users/${second.id}/status`)
      .set(asMaster())
      .send({ isActive: false, reason: 'Thanh trừng nội bộ' })

    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/master/)
  })
})

describe('Mở khoá', () => {
  it('mở khoá: đăng nhập lại được, nhưng tin KHÔNG tự hiện lại', async () => {
    await request(app)
      .patch(`/api/v1/users/${spammer.id}/status`)
      .set(asMaster())
      .send({ isActive: true })
      .expect(200)

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: spammer.email, password: PASSWORD })
      .expect(200)

    // Tin đã ẩn ở lại ẩn — tự bật hàng loạt là hồi sinh cả tin đã hết thời.
    const board = await request(app).get('/api/v1/listings').expect(200)
    expect(board.body.data.map((l: { _id: string }) => l._id)).not.toContain(spamListing)
  })
})
