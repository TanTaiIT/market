import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, TestUser, createTestApp, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * Đổi mật khẩu khi đang đăng nhập (audit 3.8), race đăng ký (3.12), và quên mật khẩu khi mail
 * tắt (3.8). Mail bị TẮT bằng mock cho cả file: ca 503 cần đúng trạng thái "chưa cấu hình mail".
 */
vi.mock('../../src/features/auth/email.sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/auth/email.sender')>()),
  mailEnabled: () => false,
}))
let app: Application
let mongod: MongoMemoryReplSet
let u: TestUser

const NEW = 'mat-khau-moi-2026'

const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password })
const refresh = (refreshToken: string) =>
  request(app).post('/api/v1/auth/refresh').send({ refreshToken })
const change = (token: string, body: object) =>
  request(app)
    .post('/api/v1/auth/password/change')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  u = await registerUser(app, 'change@pw.local', 'Người đổi mật khẩu')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('POST /auth/password/change', () => {
  it('sai mật khẩu hiện tại → 401, mật khẩu cũ vẫn đăng nhập được', async () => {
    await change(u.token, { currentPassword: 'sai-roi-123', newPassword: NEW }).expect(401)
    await login(u.email, PASSWORD).expect(200)
  })

  it('trùng mật khẩu cũ, hoặc mật khẩu mới dưới 8 ký tự → 400', async () => {
    await change(u.token, { currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400)
    await change(u.token, { currentPassword: PASSWORD, newPassword: 'ngan' }).expect(400)
  })

  it('đổi được: mật khẩu cũ chết, phiên cũ bị cắt, cặp token mới trả về dùng được ngay', async () => {
    const before = await login(u.email, PASSWORD).expect(200)
    const oldRefresh = before.body.data.tokens.refreshToken as string

    const res = await change(before.body.data.tokens.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW,
    }).expect(200)
    const fresh = res.body.data.tokens as { accessToken: string; refreshToken: string }
    expect(fresh.refreshToken).toBeTruthy()

    await refresh(oldRefresh).expect(401)
    await refresh(fresh.refreshToken).expect(200)
    await login(u.email, PASSWORD).expect(401)
    await login(u.email, NEW).expect(200)
  }, 60_000)

  it('tài khoản chưa từng có mật khẩu (Google) → 400 chỉ đường quên mật khẩu', async () => {
    const g = await registerUser(app, 'google-only@pw.local', 'Chỉ Google')
    const { User } = await import('../../src/features/user/user.model')
    await User.updateOne({ _id: g.id }, { $unset: { password: '' } }).exec()

    const res = await change(g.token, { currentPassword: 'x', newPassword: NEW })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Quên mật khẩu/)
  })

  it('không token → 401', async () => {
    await request(app)
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: PASSWORD, newPassword: NEW })
      .expect(401)
  })
})

describe('Quên mật khẩu khi mail tắt', () => {
  it('503 cho MỌI địa chỉ — có tài khoản hay không đều cùng một câu', async () => {
    const known = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'change@pw.local' })
    const unknown = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'nobody@pw.local' })

    expect(known.status).toBe(503)
    expect(unknown.status).toBe(503)
    expect(known.body.message).toBe(unknown.body.message)
  })
})

describe('Đăng ký', () => {
  it('mật khẩu 6–7 ký tự bị từ chối từ schema', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Ngắn', email: 'short@pw.local', password: 'abc123' })
      .expect(400)
  })

  it('hai lượt đăng ký cùng email đồng thời: một 201, một 409, không 500', async () => {
    const body = { name: 'Đua', email: 'race@pw.local', password: PASSWORD }
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/register').send(body),
      request(app).post('/api/v1/auth/register').send(body),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
  }, 60_000)
})
