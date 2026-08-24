import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { PASSWORD, startTestDb, createTestApp } from '../helpers/fixtures'

/**
 * Nhánh BẬT của `POST /auth/bootstrap-master` — endpoint không cần đăng nhập mà cấp quyền cao
 * nhất hệ thống, nên toàn bộ thiết kế an toàn của nó phải có test đứng sau.
 *
 * File RIÊNG chứ không gộp vào `auth.test.ts`: `env` parse `process.env` đúng một lần, lúc
 * `createTestApp()` nạp `src/app`. Một file test vì thế chỉ đo được một trạng thái môi trường —
 * nhánh "không khai token" nằm bên `auth.test.ts`.
 */

let app: Application
let mongod: MongoMemoryReplSet

const TOKEN = 'a'.repeat(64)
const EMAIL = 'master@ahasoft.vn'
const url = '/api/v1/auth/bootstrap-master'

beforeAll(async () => {
  mongod = await startTestDb()
  // PHẢI đứng trước `createTestApp()`: đó là chỗ `src/config/env.ts` được nạp lần đầu và đọc
  // `process.env`. Set sau thì `env.MASTER_SETUP_TOKEN` đã là `undefined` vĩnh viễn.
  process.env.MASTER_SETUP_TOKEN = TOKEN
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  delete process.env.MASTER_SETUP_TOKEN
  await mongoose.disconnect()
  await mongod.stop()
})

const call = (body: Record<string, unknown>) => request(app).post(url).send(body)
const ok = { setupToken: TOKEN, email: EMAIL, password: PASSWORD, name: 'Master Ahasoft' }

describe('POST /auth/bootstrap-master — cửa vào', () => {
  it('token SAI trả 404, giống hệt lúc môi trường không khai token', async () => {
    const res = await call({ ...ok, setupToken: 'b'.repeat(64) })
    // Hai ca phải KHÔNG phân biệt được từ ngoài, nếu không endpoint tự tố cáo sự tồn tại.
    expect(res.status).toBe(404)
  })

  it('token sai KHÔNG tạo tài khoản nào', async () => {
    const { User } = await import('../../src/features/user/user.model')
    expect(await User.findOne({ email: EMAIL }).exec()).toBeNull()
  })

  it('token ngắn hơn 32 ký tự bị zod chặn trước khi tới service', async () => {
    const res = await call({ ...ok, setupToken: 'abc' })
    expect(res.status).toBe(400)
  })

  it('field lạ bị chặn — schema `.strict()`, không strip im lặng', async () => {
    const res = await call({ ...ok, role: 'master' })
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/bootstrap-master — dựng master', () => {
  it('token đúng thì tạo tài khoản và cấp quyền', async () => {
    const res = await call(ok).expect(200)
    expect(res.body.data).toMatchObject({ email: EMAIL, created: true, granted: true })
    expect(res.body.data.totalMasters).toBe(1)
  })

  it('grant là master/system thật, không phải một dòng ghi suông', async () => {
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const grants = await RoleGrant.find({ revokedAt: null }).exec()
    expect(grants).toHaveLength(1)
    expect(grants[0].role).toBe('master')
    expect(grants[0].scopeType).toBe('system')
  })

  it('đăng nhập được bằng mật khẩu vừa đặt — tức là đã băm đúng đường', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)
    expect(res.body.data.tokens.accessToken).toBeTruthy()
  })

  it('gọi lại là no-op: không tạo thêm tài khoản, không cấp trùng grant', async () => {
    const res = await call(ok).expect(200)
    expect(res.body.data).toMatchObject({ created: false, granted: false, totalMasters: 1 })

    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    expect(await RoleGrant.countDocuments({ revokedAt: null }).exec()).toBe(1)
  })

  /**
   * `totalMasters` đếm NGƯỜI đăng nhập được, không đếm bản ghi grant — cùng phép đếm mà chốt
   * §5.4 dùng. Đếm grant suông sẽ báo "còn 2 master" trong khi một trong hai đã bị xoá mềm và
   * không ai vào được nữa.
   */
  it('master đã xoá mềm KHÔNG được tính vào totalMasters', async () => {
    const second = 'master2@ahasoft.vn'
    const before = await call({ ...ok, email: second }).expect(200)
    expect(before.body.data.totalMasters).toBe(2)

    const { userRepository } = await import('../../src/features/user/user.repository')
    const { User } = await import('../../src/features/user/user.model')
    const doc = await User.findOne({ email: second }).exec()
    await userRepository.softDelete(doc!._id)

    // Grant của người đó vẫn còn hiệu lực — đúng thứ khiến phép đếm theo grant nói dối.
    const after = await call(ok).expect(200)
    expect(after.body.data.totalMasters).toBe(1)
  })
})
