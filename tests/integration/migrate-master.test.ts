import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, createTestApp, registerUser, startTestDb } from '../helpers/fixtures'
import { seedMaster } from '../../scripts/migrate-master'

/**
 * `scripts/migrate-master.ts` — đường DUY NHẤT đúc tài khoản master.
 *
 * Có test vì nó là script chạy tay lúc deploy: không ai chạy thử được trên máy mình thì lỗi
 * nằm im tới đúng lúc dựng production, và đó là lúc chưa có master nào để sửa gì cả.
 */

let app: Application
let mongod: MongoMemoryReplSet

const EMAIL = 'master@ahasoft.vn'

const mastersInDb = async () => {
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  return RoleGrant.countDocuments({ role: 'master', scopeType: 'system', revokedAt: null }).exec()
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('migrate:master — dựng master lần đầu', () => {
  it('tạo tài khoản và cấp grant master/system trong một lượt', async () => {
    const res = await seedMaster(EMAIL, PASSWORD)

    expect(res.action).toBe('created')
    expect(await mastersInDb()).toBe(1)
  })

  it('đăng nhập được bằng mật khẩu vừa đặt — tức là đã băm đúng đường', async () => {
    // Chốt thật của việc dùng `save()` thay vì `updateOne`: bỏ qua hook `pre('save')` là ghi
    // mật khẩu nguyên văn xuống DB, và bài test duy nhất bắt được là đăng nhập thử.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)
    expect(res.body.data.tokens.accessToken).toBeTruthy()
  })

  it('tên mặc định là nhãn hệ thống, không phải tên người thật', async () => {
    const { User } = await import('../../src/features/user/user.model')
    const user = await User.findOne({ email: EMAIL }).exec()
    expect(user?.name).toBe('Quản trị hệ thống')
  })
})

describe('migrate:master — trần một master', () => {
  it('chạy lại là no-op, KHÔNG tạo master thứ hai', async () => {
    const res = await seedMaster(EMAIL, PASSWORD)

    expect(res).toMatchObject({ action: 'skipped', usableMasters: 1 })
    expect(await mastersInDb()).toBe(1)
  })

  /**
   * Ca nguy hiểm nhất: đổi `MASTER_EMAIL` sang người khác rồi chạy lại. Script phải TỪ CHỐI —
   * nếu không, biến môi trường trở thành đường tạo master thứ hai, đúng cái cửa mà việc gỡ
   * `POST /auth/bootstrap-master` vừa đóng lại.
   */
  it('email KHÁC cũng không tạo được master mới khi đã có một cái', async () => {
    const res = await seedMaster('nguoi-khac@ahasoft.vn', PASSWORD)

    expect(res.action).toBe('skipped')
    expect(await mastersInDb()).toBe(1)

    const { User } = await import('../../src/features/user/user.model')
    expect(await User.findOne({ email: 'nguoi-khac@ahasoft.vn' }).exec()).toBeNull()
  })
})

describe('migrate:master — dựng lại khi hệ thống thực tế không còn master', () => {
  /**
   * Grant còn hiệu lực nhưng tài khoản đã bị KHOÁ = không ai đăng nhập được = hệ thống không
   * có master. Đếm theo bản ghi grant sẽ báo "vẫn còn 1" và khoá luôn đường dựng lại — chính
   * lý do `seedMaster` đếm NGƯỜI đăng nhập được.
   */
  it('master bị khoá thì lượt chạy sau mở lại và đặt mật khẩu mới', async () => {
    const { User } = await import('../../src/features/user/user.model')
    await User.updateOne({ email: EMAIL }, { isActive: false }).exec()

    const res = await seedMaster(EMAIL, 'mat-khau-moi-123')
    expect(res.action).toBe('reused')

    const user = await User.findOne({ email: EMAIL }).exec()
    expect(user?.isActive).toBe(true)

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: 'mat-khau-moi-123' })
      .expect(200)
  })

  it('không sinh grant trùng khi dùng lại tài khoản cũ', async () => {
    // `reused` vẫn cấp một grant mới, nhưng grant cũ đã đi cùng tài khoản bị khoá — hệ thống
    // phải kết thúc với đúng một master đăng nhập được, không phải hai dòng grant chồng nhau.
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const { User } = await import('../../src/features/user/user.model')
    const user = await User.findOne({ email: EMAIL }).exec()

    const grants = await RoleGrant.countDocuments({
      userId: user!._id,
      role: 'master',
      revokedAt: null,
    }).exec()
    expect(grants).toBe(1)
  })
})

describe('nhãn hệ thống là tên giữ riêng', () => {
  /**
   * `MASTER_DISPLAY_NAME` đi vào snapshot của nhật ký duyệt, nên nó MANG THẨM QUYỀN. Che tên
   * master mà vẫn cho người khác đặt đúng cái tên ấy là mở lại đúng cái lỗ vừa bịt.
   */
  it('không đăng ký được tài khoản mang tên nhãn hệ thống', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Quản trị hệ thống', email: 'gia-mao@example.com', password: PASSWORD })

    expect(res.status).toBe(400)
  })

  it('chặn cả biến thể khác hoa-thường và thừa khoảng trắng', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '  quản trị   HỆ THỐNG ', email: 'gia-mao2@example.com', password: PASSWORD })

    expect(res.status).toBe(400)
  })

  it('không đổi tên hồ sơ thành nhãn hệ thống được', async () => {
    const user = await registerUser(app, 'nguoi-thuong@example.com', 'Người thường')

    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Quản trị hệ thống' })

    expect(res.status).toBe(400)
  })

  it('tên bình thường vẫn đổi được — chốt không chặn quá tay', async () => {
    const user = await registerUser(app, 'nguoi-thuong-2@example.com', 'Người thường hai')

    await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Trần Quản Trị' })
      .expect(200)
  })
})
