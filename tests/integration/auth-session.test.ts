import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { createTestApp, startTestDb, PASSWORD } from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

/** Đăng ký một tài khoản mới và trả về CẶP token của nó. */
async function signUp(email: string) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Người dùng', email, password: PASSWORD })
    .expect(201)
  return res.body.data.tokens as { accessToken: string; refreshToken: string }
}

const refresh = (refreshToken: string) =>
  request(app).post('/api/v1/auth/refresh').send({ refreshToken })

const logout = (accessToken: string) =>
  request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`)

describe('Vòng đời phiên — đăng xuất cắt được refresh token', () => {
  it('refresh chạy được trước khi đăng xuất', async () => {
    const s = await signUp('a@session.local')
    const res = await refresh(s.refreshToken).expect(200)
    expect(res.body.data.tokens.accessToken).toBeTruthy()
  }, 60_000)

  /**
   * Đây là lỗ mà `tokenVersion` sinh ra để bịt: trước đó refresh token là bearer stateless
   * sống 30 ngày, server không lưu gì nên KHÔNG có gì để thu hồi — token bị lộ dùng được tới
   * hết hạn, và đăng xuất chỉ xoá token khỏi máy người dùng chứ không cắt được ai.
   */
  it('đăng xuất xong thì refresh token cũ chết ngay', async () => {
    const s = await signUp('b@session.local')

    await logout(s.accessToken).expect(200)

    const res = await refresh(s.refreshToken).expect(401)
    expect(res.body.message).toMatch(/Phiên đã kết thúc/)
  }, 60_000)

  /** Cắt MỌI thiết bị: token phát ở lần đăng nhập khác cũng phải chết. */
  it('token của phiên khác cũng chết theo', async () => {
    const email = 'c@session.local'
    const first = await signUp(email)
    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)

    await logout(first.accessToken).expect(200)

    await refresh(first.refreshToken).expect(401)
    await refresh(second.body.data.tokens.refreshToken).expect(401)
  }, 60_000)

  /** Đăng nhập lại sau khi đăng xuất phải dùng được ngay — chốt không được kẹt ở trạng thái chết. */
  it('đăng nhập lại thì phiên mới hoạt động bình thường', async () => {
    const email = 'd@session.local'
    const s = await signUp(email)
    await logout(s.accessToken).expect(200)

    const again = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)
    await refresh(again.body.data.tokens.refreshToken).expect(200)
  }, 60_000)

  it('đăng xuất đòi access token hợp lệ', async () => {
    await request(app).post('/api/v1/auth/logout').expect(401)
  }, 60_000)

  /**
   * Tài khoản có TRƯỚC khi thêm `tokenVersion` không mang trường đó, và refresh token cũ cũng
   * không mang `ver`. Cả hai phải đọc là 0 và khớp nhau — nếu không thì deploy bản này là đá
   * toàn bộ người dùng đang đăng nhập ra ngoài.
   */
  it('token cũ không có `ver` vẫn refresh được sau khi deploy', async () => {
    const s = await signUp('e@session.local')
    const { User } = await import('../../src/features/user/user.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')

    // Dựng lại đúng hình dạng dữ liệu cũ: xoá hẳn field khỏi document.
    await runUnscoped('test: giả lập tài khoản trước khi có tokenVersion', () =>
      User.updateOne({ email: 'e@session.local' }, { $unset: { tokenVersion: '' } }).exec(),
    )

    await refresh(s.refreshToken).expect(200)
  }, 60_000)
})
