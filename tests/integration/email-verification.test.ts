import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * Xác thực email bằng mã 6 số.
 *
 * `email.sender` bị mock — test này canh LUẬT, không canh việc Resend có gửi được thư không.
 * Nhờ mock mà mã thật lọt ra để test gõ vào; ngoài đời nó chỉ tồn tại trong hộp thư người dùng.
 *
 * Ba chốt bảo mật, và cả ba đều quan trọng hơn phần "đường sáng" ở trên cùng:
 *
 * 1. Người dùng lấy từ TOKEN, không từ body — body có email thì endpoint thành máy dò tài khoản.
 * 2. Sai 5 lần là mã chết, kể cả sau đó gõ đúng.
 * 3. Hết hạn thì hỏng, và chốt đó nằm ở code chứ không ở TTL index (Mongo quét mỗi ~60 giây).
 */

let app: Application
let mongod: MongoMemoryReplSet
let ai: TestUser
let nguoiKhac: TestUser

/** Mã cuối cùng "đã gửi", theo email nhận. Thay cho việc mở hộp thư. */
const daGui = new Map<string, string>()

vi.mock('../../src/features/auth/email.sender', () => ({
  mailEnabled: () => true,
  sendVerificationCode: vi.fn(async (to: string, code: string) => {
    daGui.set(to, code)
  }),
}))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  ai = await registerUser(app, 'can-xac-thuc@ghim.local', 'Người cần xác thực')
  nguoiKhac = await registerUser(app, 'nguoi-khac@ghim.local', 'Người khác')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const sendCode = (u: TestUser) => request(app).post('/api/v1/auth/email/send-code').set(auth(u))
const verify = (u: TestUser, code: string) =>
  request(app).post('/api/v1/auth/email/verify').set(auth(u)).send({ code })

async function model() {
  return (await import('../../src/features/auth/email-verification.model')).EmailVerification
}

/** Lùi mốc gửi để qua hạn chờ 60 giây mà không phải chờ thật. */
async function boQuaHanCho(u: TestUser) {
  const EmailVerification = await model()
  await EmailVerification.updateOne(
    { userId: new mongoose.Types.ObjectId(u.id) },
    { sentAt: new Date(Date.now() - 120_000) },
  ).exec()
}

async function daXacThuc(u: TestUser): Promise<boolean> {
  const res = await request(app).get('/api/v1/users/me').set(auth(u)).expect(200)
  return res.body.data.isEmailVerified
}

describe('Gửi mã', () => {
  it('tài khoản mật khẩu mới đăng ký CHƯA được xác thực', async () => {
    expect(await daXacThuc(ai)).toBe(false)
  }, 60_000)

  it('gửi mã → 200, thư đi đúng địa chỉ của người trong token', async () => {
    const res = await sendCode(ai).expect(200)

    expect(res.body.data.expiresInSeconds).toBe(600)
    expect(res.body.data.resendAfterSeconds).toBe(60)
    expect(daGui.get(ai.email)).toMatch(/^\d{6}$/)
  }, 60_000)

  it('gửi lại ngay → 429, không gửi thêm thư nào', async () => {
    const truoc = daGui.get(ai.email)
    await sendCode(ai).expect(429)
    expect(daGui.get(ai.email)).toBe(truoc)
  }, 60_000)

  it('khách chưa đăng nhập → 401', async () => {
    await request(app).post('/api/v1/auth/email/send-code').expect(401)
    await request(app).post('/api/v1/auth/email/verify').send({ code: '123456' }).expect(401)
  }, 60_000)

  it('gửi lại sau hạn chờ → mã CŨ chết, chỉ mã mới dùng được', async () => {
    const cu = daGui.get(ai.email)!
    await boQuaHanCho(ai)
    await sendCode(ai).expect(200)
    const moi = daGui.get(ai.email)!

    expect(moi).not.toBe(cu)
    await verify(ai, cu).expect(400)
    expect(await daXacThuc(ai)).toBe(false)
  }, 60_000)
})

describe('Nhập mã', () => {
  it('sai định dạng (5 số, có chữ) → 400 ngay ở cửa', async () => {
    await verify(ai, '12345').expect(400)
    await verify(ai, 'abcdef').expect(400)
  }, 60_000)

  /** Mã của người này KHÔNG mở được tài khoản người kia — khoá là `userId` trong token. */
  it('mã của người khác → 400', async () => {
    await verify(nguoiKhac, daGui.get(ai.email)!).expect(400)
    expect(await daXacThuc(nguoiKhac)).toBe(false)
  }, 60_000)

  it('mã hết hạn → 400, dù bản ghi còn nằm đó', async () => {
    const EmailVerification = await model()
    await EmailVerification.updateOne(
      { userId: new mongoose.Types.ObjectId(ai.id) },
      { expiresAt: new Date(Date.now() - 1000) },
    ).exec()

    await verify(ai, daGui.get(ai.email)!).expect(400)
    expect(await daXacThuc(ai)).toBe(false)
  }, 60_000)

  it('sai 5 lần → mã chết, gõ ĐÚNG sau đó vẫn 400', async () => {
    await boQuaHanCho(ai)
    await sendCode(ai).expect(200)
    const dung = daGui.get(ai.email)!
    // Mã sai chắc chắn khác mã đúng, kể cả khi CSPRNG trả về đúng '000000'.
    const sai = dung === '000000' ? '111111' : '000000'

    for (let i = 0; i < 5; i++) await verify(ai, sai).expect(400)

    await verify(ai, dung).expect(400)
    expect(await daXacThuc(ai)).toBe(false)

    const EmailVerification = await model()
    const con = await EmailVerification.findOne({
      userId: new mongoose.Types.ObjectId(ai.id),
    }).exec()
    // Bản ghi chết bị XOÁ, không nằm lại: gửi lại là có mã mới ngay.
    expect(con).toBeNull()
  }, 60_000)

  it('mã đúng → xác thực xong, và bản ghi mã biến mất', async () => {
    await sendCode(ai).expect(200)
    await verify(ai, daGui.get(ai.email)!).expect(200)

    expect(await daXacThuc(ai)).toBe(true)

    const EmailVerification = await model()
    expect(
      await EmailVerification.findOne({ userId: new mongoose.Types.ObjectId(ai.id) }).exec(),
    ).toBeNull()
  }, 60_000)

  it('đã xác thực rồi thì không gửi mã nữa → 409', async () => {
    await sendCode(ai).expect(409)
  }, 60_000)
})
