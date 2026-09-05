import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, startTestDb, createTestApp } from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

const EMAIL = 'nguyenvana@example.com'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Auth v2 — tài khoản toàn cục', () => {
  it('đăng ký chỉ tạo tài khoản, KHÔNG tạo tổ chức', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Nguyễn Văn A', email: EMAIL, password: PASSWORD })

    expect(res.status).toBe(201)
    expect(res.body.data.user.id).toBeTruthy()
    // Không còn `organizationId` trong response: org là quan hệ, không phải thuộc tính của user.
    expect(res.body.data.user.organizationId).toBeUndefined()
  })

  it('từ chối gửi kèm organizationName — luồng tạo org đã chuyển sang master', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'B',
      email: 'b@example.com',
      password: PASSWORD,
      organizationName: 'Tự tạo org',
    })
    expect(res.status).toBe(400)
  })

  it('email trùng bị chặn ở phạm vi TOÀN CỤC', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Trùng', email: EMAIL, password: PASSWORD })
    expect(res.status).toBe(409)
  })

  it('đăng nhập chỉ cần email + password, không cần orgSlug', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.data.tokens.accessToken).toBeTruthy()
  })

  it('sai mật khẩu vẫn 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: 'sai-mat-khau' })
    expect(res.status).toBe(401)
  })

  it('refresh trả token mới cho đúng tài khoản', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.tokens.refreshToken })

    expect(res.status).toBe(200)
    expect(res.body.data.user.email).toBe(EMAIL)
  })
})

/**
 * Kiểm tra HÌNH DẠNG response, không phải nghiệp vụ.
 *
 * `/users/me` từng trả nguyên document trong khi schema OpenAPI vẫn khai `role: string` —
 * model đã bỏ cột đó từ lâu. SDK sinh ra `role: string`, app gọi `.trim()` và nổ ở runtime.
 * Không test nào bắt được vì chưa test nào nhìn vào chính cái response ấy.
 */
describe('GET /users/me — response khớp với schema đã công bố', () => {
  it('đúng bộ field whitelist, không rò cột nào của model', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .expect(200)

    // `location` không có mặt vì tài khoản mới chưa điền — đúng: field vắng mặt mang nghĩa
    // "chưa có", khác hẳn một subdoc rỗng.
    //
    // `area` thì NGƯỢC LẠI, luôn có mặt và ở đây là `null`: nó không phải dữ liệu người dùng
    // nhập mà là kết quả đã giải (`resolveArea`), nên "chưa đủ căn cứ" phải nói ra tường minh.
    // Tài khoản mới chưa khai khu vực và chưa đăng tin nào nên cả hai bậc đều trượt.
    expect(res.body.data.area).toBeNull()
    expect(Object.keys(res.body.data).sort()).toEqual([
      'area',
      'avatar',
      'createdAt',
      'email',
      'gender',
      'id',
      'isActive',
      'isEmailVerified',
      'name',
      'ratingAvg',
      'ratingCount',
      'showPhone',
    ])
    // `role` là quan hệ (membership / role_grant), không phải thuộc tính của tài khoản.
    expect(res.body.data.role).toBeUndefined()
    expect(res.body.data.password).toBeUndefined()
    expect(res.body.data.isEmailVerified).toBe(false)
  })
})
