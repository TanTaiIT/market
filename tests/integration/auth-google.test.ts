import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, createTestApp, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * `POST /auth/google` — đăng nhập / đăng ký bằng Google.
 *
 * `verifyGoogleIdToken` bị mock: test này canh LUẬT NGHIỆP VỤ sau khi token đã hợp lệ (khớp ai,
 * liên kết thế nào, mật khẩu cũ ra sao). Việc kiểm chữ ký là của `google-auth-library` và không
 * mock được bằng một token tự soạn — muốn canh vế đó thì phải gọi Google thật, tức không còn là
 * unit/integration test nữa.
 *
 * Ca quan trọng nhất là "chiếm tài khoản trước": kẻ tấn công đăng ký bằng mật khẩu TRƯỚC, chủ
 * hộp thư đăng nhập Google SAU. Test khẳng định mật khẩu của kẻ tấn công hết hiệu lực ngay.
 */

let app: Application
let mongod: MongoMemoryReplSet

const NEW_EMAIL = 'nguoi-moi@gmail.com'
const OWNED_EMAIL = 'chu-hop-thu@gmail.com'

/** Danh tính Google giả — thay cho kết quả của `verifyGoogleIdToken`. */
const identity = (email: string, googleId: string) => ({
  googleId,
  email,
  name: 'Người Google',
  picture: 'https://lh3.googleusercontent.com/a/anh.jpg',
})

vi.mock('../../src/features/auth/google.verify', () => ({
  allowedAudiences: () => ['test-client-id'],
  // `idToken` mang thẳng "email|sub" để mỗi test tự chọn danh tính mà không cần mock lại.
  verifyGoogleIdToken: vi.fn(async (idToken: string) => {
    if (idToken === 'xau')
      throw new (await import('../../src/common/errors')).UnauthorizedError(
        'Token Google không hợp lệ hoặc đã hết hạn',
      )
    const [email, sub] = idToken.split('|')
    return identity(email, sub)
  }),
}))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const google = (idToken: string) => request(app).post('/api/v1/auth/google').send({ idToken })
const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password })

async function userRow(email: string) {
  const { User } = await import('../../src/features/user/user.model')
  return User.findOne({ email })
    .select('+password googleId tokenVersion emailVerifiedAt')
    .lean()
    .exec()
}

describe('Đăng ký bằng Google', () => {
  it('email chưa có tài khoản → tạo mới, không mật khẩu, email coi như đã xác thực', async () => {
    const res = await google(`${NEW_EMAIL}|sub-moi`).expect(200)

    expect(res.body.data.user.email).toBe(NEW_EMAIL)
    expect(res.body.data.tokens.accessToken).toBeTypeOf('string')

    const row = await userRow(NEW_EMAIL)
    expect(row?.googleId).toBe('sub-moi')
    // KHÔNG sinh mật khẩu ngẫu nhiên: đó sẽ là một chứng chỉ thật mà chủ tài khoản không biết.
    expect(row?.password).toBeUndefined()
    // Google vừa chứng minh hộp thư — đây là lần đầu hệ thống có bằng chứng đó.
    expect(row?.emailVerifiedAt).not.toBeNull()
  }, 60_000)

  it('gọi lần hai → đăng nhập vào ĐÚNG tài khoản cũ, không tạo thêm', async () => {
    const before = await userRow(NEW_EMAIL)
    await google(`${NEW_EMAIL}|sub-moi`).expect(200)
    const after = await userRow(NEW_EMAIL)
    expect(String(after?._id)).toBe(String(before?._id))
  }, 60_000)

  /**
   * Khớp theo `sub` TRƯỚC email: người dùng đổi địa chỉ Gmail thì `sub` không đổi. Khớp email
   * trước sẽ tạo tài khoản thứ hai cho cùng một người và bỏ rơi tin đăng ở tài khoản cũ.
   */
  it('cùng `sub` nhưng email đã đổi → vẫn là tài khoản đó', async () => {
    const before = await userRow(NEW_EMAIL)
    await google(`dia-chi-moi@gmail.com|sub-moi`).expect(200)

    const after = await userRow(NEW_EMAIL)
    expect(String(after?._id)).toBe(String(before?._id))
    // Không tạo bản ghi nào cho địa chỉ mới.
    expect(await userRow('dia-chi-moi@gmail.com')).toBeNull()
  }, 60_000)

  it('token không hợp lệ → 401', async () => {
    await google('xau').expect(401)
  }, 60_000)
})

describe('Chốt chống chiếm tài khoản trước', () => {
  it('liên kết tài khoản mật khẩu sẵn có, và RÚT mật khẩu cũ', async () => {
    // Kẻ tấn công đăng ký trước bằng email của người khác.
    await registerUser(app, OWNED_EMAIL, 'Kẻ đăng ký trước')
    await login(OWNED_EMAIL, PASSWORD).expect(200)

    const before = await userRow(OWNED_EMAIL)
    expect(before?.password).toBeTypeOf('string')

    // Chủ hộp thư thật đăng nhập bằng Google.
    const res = await google(`${OWNED_EMAIL}|sub-chu-that`).expect(200)
    expect(res.body.data.user.email).toBe(OWNED_EMAIL)

    const after = await userRow(OWNED_EMAIL)
    // Cùng một tài khoản — tin đăng và hội thoại cũ không bị bỏ rơi.
    expect(String(after?._id)).toBe(String(before?._id))
    expect(after?.googleId).toBe('sub-chu-that')
    // Ba hệ quả bắt buộc của việc liên kết:
    expect(after?.password).toBeUndefined()
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1)
    expect(after?.emailVerifiedAt).not.toBeNull()
  }, 60_000)

  it('mật khẩu của kẻ đăng ký trước KHÔNG còn dùng được', async () => {
    // 401, không phải 500: `comparePassword` trả `false` khi không có hash thay vì để `verify` ném.
    const res = await login(OWNED_EMAIL, PASSWORD)
    expect(res.status).toBe(401)
  }, 60_000)

  it('sau khi liên kết vẫn vào được bằng Google', async () => {
    await google(`${OWNED_EMAIL}|sub-chu-that`).expect(200)
  }, 60_000)
})
