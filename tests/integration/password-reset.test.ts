import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, TestUser, createTestApp, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * Quên mật khẩu bằng mã 6 số.
 *
 * Phần lớn file này canh những thứ endpoint **không được nói ra**. Cửa này nhận email trong
 * body và trả lời cho bất kỳ ai, nên mọi khác biệt quan sát được giữa "địa chỉ có tài khoản" và
 * "địa chỉ lạ" — mã trạng thái, câu chữ, thậm chí việc có thư đi hay không — đều là câu trả lời
 * cho câu hỏi mà một máy dò đang hỏi.
 */

let app: Application
let mongod: MongoMemoryReplSet
let chu: TestUser
let biKhoa: TestUser

const MK_MOI = 'matkhaumoi456'

/** Mã cuối cùng "đã gửi", theo email nhận. Thay cho việc mở hộp thư. */
const daGui = new Map<string, string>()

vi.mock('../../src/features/auth/email.sender', () => ({
  mailEnabled: () => true,
  sendVerificationCode: vi.fn(async () => {}),
  sendPasswordResetCode: vi.fn(async (to: string, code: string) => {
    daGui.set(to, code)
  }),
}))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  chu = await registerUser(app, 'quen-mk@ghim.local', 'Người quên mật khẩu')
  biKhoa = await registerUser(app, 'bi-khoa@ghim.local', 'Người bị khoá')

  const { User } = await import('../../src/features/user/user.model')
  await User.updateOne({ _id: biKhoa.id }, { isActive: false }).exec()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const forgot = (email: string) => request(app).post('/api/v1/auth/password/forgot').send({ email })
const verifyCode = (email: string, code: string) =>
  request(app).post('/api/v1/auth/password/verify-code').send({ email, code })
const reset = (email: string, resetToken: string, password: string) =>
  request(app).post('/api/v1/auth/password/reset').send({ email, resetToken, password })

/** Đi trọn hai bước cuối — dùng ở những ca chỉ quan tâm kết quả, không quan tâm bước giữa. */
async function doiMatKhau(email: string, code: string, matKhau: string) {
  const ve = await verifyCode(email, code).expect(200)
  return reset(email, ve.body.data.resetToken, matKhau).expect(200)
}
const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password })

/** Lùi mốc gửi để qua hạn chờ 60 giây mà không phải chờ thật. */
async function boQuaHanCho(u: TestUser) {
  const { EmailVerification } = await import('../../src/features/auth/email-verification.model')
  await EmailVerification.updateOne(
    { userId: new mongoose.Types.ObjectId(u.id), purpose: 'reset_password' },
    { sentAt: new Date(Date.now() - 120_000) },
  ).exec()
}

describe('Xin mã — cửa không được lộ tài khoản nào tồn tại', () => {
  it('email CÓ tài khoản → 200, thư đi', async () => {
    await forgot(chu.email).expect(200)
    expect(daGui.get(chu.email)).toMatch(/^\d{6}$/)
  }, 60_000)

  /** Chốt chống dò: cùng mã trạng thái VÀ cùng câu chữ với ca có tài khoản. */
  it('email KHÔNG có tài khoản → vẫn 200, cùng thông điệp, không thư nào đi', async () => {
    const co = await forgot(chu.email)
    const khong = await forgot('khong-ton-tai@ghim.local').expect(200)

    expect(khong.body.message).toBe(co.body.message)
    expect(daGui.has('khong-ton-tai@ghim.local')).toBe(false)
  }, 60_000)

  it('tài khoản bị KHOÁ → vẫn 200, không thư nào đi', async () => {
    await forgot(biKhoa.email).expect(200)
    expect(daGui.has(biKhoa.email)).toBe(false)
  }, 60_000)

  it('email sai định dạng → 400 (chặn ở schema, chưa chạm DB)', async () => {
    await forgot('khong-phai-email').expect(400)
  }, 60_000)
})

describe('Bước 2 — đổi mã lấy vé', () => {
  it('mã sai → 400, và KHÔNG phát vé', async () => {
    await boQuaHanCho(chu)
    await forgot(chu.email).expect(200)
    const dung = daGui.get(chu.email)!
    const sai = dung === '000000' ? '111111' : '000000'

    const res = await verifyCode(chu.email, sai).expect(400)
    expect(res.body.data?.resetToken).toBeUndefined()
    // Mật khẩu cũ vẫn dùng được: một lượt hỏng ở bước giữa không được đụng gì.
    await login(chu.email, PASSWORD).expect(200)
  }, 60_000)

  /**
   * Chốt chống dò: nhánh 'email không tồn tại' phải trả CÙNG mã trạng thái với nhánh mã sai.
   * Ném 401 ở đó thì câu chữ giống nhau cũng vô nghĩa — máy dò chỉ cần đọc con số.
   */
  it('email lạ → 400, ĐÚNG mã trạng thái của mã sai', async () => {
    await verifyCode('khong-ton-tai@ghim.local', '123456').expect(400)
  }, 60_000)

  it('mã đúng → nhận vé, và mã CHẾT ngay (không đổi được lần hai)', async () => {
    const ma = daGui.get(chu.email)!
    const ve = await verifyCode(chu.email, ma).expect(200)
    expect(ve.body.data.resetToken).toEqual(expect.any(String))

    await verifyCode(chu.email, ma).expect(400)
  }, 60_000)
})

describe('Bước 3 — đổi vé lấy mật khẩu mới', () => {
  it('vé bịa → 400', async () => {
    await reset(chu.email, 'khong-phai-ve', MK_MOI).expect(400)
  }, 60_000)

  it('mật khẩu mới quá ngắn → 400 (chặn ở schema, vé chưa bị tiêu)', async () => {
    await boQuaHanCho(chu)
    await forgot(chu.email).expect(200)
    const ve = (await verifyCode(chu.email, daGui.get(chu.email)!).expect(200)).body.data.resetToken

    await reset(chu.email, ve, 'abc').expect(400)
    // Vé vẫn còn: lỗi độ dài bị chặn trước khi chạm tới nó.
    await reset(chu.email, ve, MK_MOI).expect(200)
  }, 60_000)

  it('đăng nhập được bằng mật khẩu MỚI, mật khẩu cũ chết', async () => {
    await login(chu.email, MK_MOI).expect(200)
    await login(chu.email, PASSWORD).expect(401)
  }, 60_000)

  it('vé đã dùng KHÔNG dùng lại được', async () => {
    await boQuaHanCho(chu)
    await forgot(chu.email).expect(200)
    const ve = (await verifyCode(chu.email, daGui.get(chu.email)!).expect(200)).body.data.resetToken

    await reset(chu.email, ve, 'matkhau-lan-hai').expect(200)
    await reset(chu.email, ve, 'matkhau-lan-ba').expect(400)
    await login(chu.email, 'matkhau-lan-hai').expect(200)
  }, 60_000)

  /**
   * Người đi đặt lại mật khẩu thường đang nghi bị chiếm tài khoản. Đổi mật khẩu mà để refresh
   * token của kẻ kia sống tiếp 14 ngày thì chưa giải quyết được gì.
   */
  it('phiên cũ bị CẮT — refresh token phát trước lượt reset thành vô hiệu', async () => {
    const truoc = await login(chu.email, 'matkhau-lan-hai').expect(200)
    const refreshCu = truoc.body.data.tokens.refreshToken as string

    await boQuaHanCho(chu)
    await forgot(chu.email).expect(200)
    await doiMatKhau(chu.email, daGui.get(chu.email)!, 'matkhau-sau-cung')

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshCu }).expect(401)
  }, 60_000)

  it('đặt lại mật khẩu cũng đánh dấu email đã xác thực', async () => {
    const res = await login(chu.email, 'matkhau-sau-cung').expect(200)
    const me = await request(app)
      .get('/api/v1/users/me')
      .set({ Authorization: `Bearer ${res.body.data.tokens.accessToken}` })
      .expect(200)

    expect(me.body.data.isEmailVerified).toBe(true)
  }, 60_000)
})

describe('Mã của cửa này không mở được cửa kia', () => {
  /**
   * Hai luồng dùng chung một collection, phân biệt bằng `purpose`. Nếu một lượt tra quên lọc
   * theo `purpose` thì mã đặt lại mật khẩu sẽ xác thực được email và ngược lại — đúng thứ khoá
   * duy nhất theo cặp `(userId, purpose)` sinh ra để chặn.
   */
  it('mã đặt lại mật khẩu KHÔNG dùng để xác thực email được', async () => {
    const nguoiMoi = await registerUser(app, 'hai-cua@ghim.local', 'Hai cửa', { verified: false })

    await forgot(nguoiMoi.email).expect(200)
    const maReset = daGui.get(nguoiMoi.email)!

    await request(app)
      .post('/api/v1/auth/email/verify')
      .set({ Authorization: `Bearer ${nguoiMoi.token}` })
      .send({ code: maReset })
      .expect(400)
  }, 60_000)
})
