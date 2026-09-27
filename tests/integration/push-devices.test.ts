import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  PASSWORD,
  TestUser,
  createTestApp,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { pushConfig } from '../../src/features/push/push.service'
import { PushDevice, PushOutbox } from '../../src/features/push/push.model'

/**
 * Thiết bị nhận push + công tắc + vòng đời phiên (push-notification.plan.md §4.2, §4.5).
 *
 * Chốt quan trọng nhất ở đây là mục tiêu 4 của plan: KHÔNG gửi nhầm người. Đổi tài khoản trên
 * cùng máy, đăng xuất, đổi mật khẩu, bị khoá, xoá tài khoản — sau mỗi việc đó, máy nào không còn
 * đăng nhập tài khoản thì không còn dòng thiết bị nào trỏ về nó.
 */
let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
let seq = 0
const newToken = () => `ExponentPushToken[device${(seq += 1).toString().padStart(8, '0')}]`

function register(u: TestUser, token: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/push/devices')
    .set(bearer(u))
    .send({ token, platform: 'android', appVersion: '1.0.0', ...extra })
}

const devicesOf = (userId: string) => PushDevice.find({ userId }).lean().exec()

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Đăng ký thiết bị', () => {
  it('token sai định dạng → 400; chưa đăng nhập → 401', async () => {
    const u = await registerUser(app, 'bad-token@push.local')
    await register(u, 'not-a-token').expect(400)
    await request(app)
      .post('/api/v1/push/devices')
      .send({ token: newToken(), platform: 'android' })
      .expect(401)
  })

  it('đăng ký thành công; response KHÔNG trả lại token', async () => {
    const u = await registerUser(app, 'ok@push.local')
    const res = await register(u, newToken(), { deviceName: 'Pixel 8' }).expect(200)
    expect(res.body.data).toMatchObject({ platform: 'android', deviceName: 'Pixel 8' })
    expect(res.body.data).not.toHaveProperty('token')
    expect(await devicesOf(u.id)).toHaveLength(1)
  })

  it('đăng ký lại cùng token (mở app lần nữa) → vẫn một dòng, cập nhật lastSeenAt', async () => {
    const u = await registerUser(app, 'reopen@push.local')
    const token = newToken()
    await register(u, token).expect(200)
    const [before] = await devicesOf(u.id)
    await new Promise((r) => setTimeout(r, 5))
    await register(u, token, { appVersion: '1.0.1' }).expect(200)
    const after = await devicesOf(u.id)
    expect(after).toHaveLength(1)
    expect(after[0].appVersion).toBe('1.0.1')
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime())
  })

  it('B đăng nhập trên máy của A → máy chuyển sang B, A thôi nhận push trên máy đó', async () => {
    const a = await registerUser(app, 'a@shared-phone.local')
    const b = await registerUser(app, 'b@shared-phone.local')
    const token = newToken()
    await register(a, token).expect(200)
    await register(b, token).expect(200)

    expect(await devicesOf(a.id)).toHaveLength(0)
    expect(await devicesOf(b.id)).toHaveLength(1)
  })

  it('giữ tối đa 10 máy dùng gần nhất', async () => {
    const u = await registerUser(app, 'many@push.local')
    const tokens = Array.from({ length: 12 }, newToken)
    for (const t of tokens) await register(u, t).expect(200)

    const kept = (await devicesOf(u.id)).map((d) => d.token)
    expect(kept).toHaveLength(10)
    expect(kept).not.toContain(tokens[0])
    expect(kept).toContain(tokens[11])
  })

  it('gỡ máy KHÔNG cần đăng nhập (phiên có thể đã chết trước khi app kịp gỡ)', async () => {
    const u = await registerUser(app, 'unregister@push.local')
    const token = newToken()
    await register(u, token).expect(200)

    await request(app).post('/api/v1/push/devices/unregister').send({ token }).expect(200)
    expect(await devicesOf(u.id)).toHaveLength(0)
    // Token không tồn tại vẫn 200 — không xác nhận cho người ngoài token nào đang được dùng.
    await request(app).post('/api/v1/push/devices/unregister').send({ token }).expect(200)
  })
})

describe('Công tắc push', () => {
  it('mặc định: bật hết trừ group_activity; `account` nằm trong danh sách khoá', async () => {
    const u = await registerUser(app, 'prefs-default@push.local')
    const res = await request(app).get('/api/v1/push/preferences').set(bearer(u)).expect(200)
    expect(res.body.data.enabled).toBe(true)
    expect(res.body.data.categories).toMatchObject({
      chat: true,
      listing_status: true,
      group_activity: false,
      account: true,
    })
    expect(res.body.data.locked).toEqual(['account'])
  })

  it('đổi từng công tắc, giữ nguyên phần còn lại', async () => {
    const u = await registerUser(app, 'prefs-patch@push.local')
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ categories: { chat: false } })
      .expect(200)
    const res = await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ categories: { group_activity: true } })
      .expect(200)
    expect(res.body.data.categories).toMatchObject({ chat: false, group_activity: true })

    const off = await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ enabled: false })
      .expect(200)
    expect(off.body.data.enabled).toBe(false)
    expect(off.body.data.categories.chat).toBe(false)
  })

  it('gửi `account` hoặc khoá lạ → 400 (không lặng lẽ bỏ qua)', async () => {
    const u = await registerUser(app, 'prefs-locked@push.local')
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ categories: { account: false } })
      .expect(400)
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ categories: { marketing: true } })
      .expect(400)
  })
})

describe('Vòng đời phiên — máy bị đá ra thì thôi nhận push', () => {
  it('đăng xuất (mọi thiết bị) → gỡ mọi máy', async () => {
    const u = await registerUser(app, 'logout@push.local')
    await register(u, newToken()).expect(200)
    await register(u, newToken()).expect(200)

    await request(app).post('/api/v1/auth/logout').set(bearer(u)).expect(200)
    expect(await devicesOf(u.id)).toHaveLength(0)
  })

  it('đổi mật khẩu → giữ máy đang đổi (X-Push-Token), gỡ mọi máy khác', async () => {
    const u = await registerUser(app, 'change-pw@push.local')
    const here = newToken()
    await register(u, here).expect(200)
    await register(u, newToken()).expect(200)

    await request(app)
      .post('/api/v1/auth/password/change')
      .set(bearer(u))
      .set('X-Push-Token', here)
      .send({ currentPassword: PASSWORD, newPassword: 'mat-khau-moi-2026' })
      .expect(200)

    expect((await devicesOf(u.id)).map((d) => d.token)).toEqual([here])
  })

  it('refresh token bị dùng lại (nghi bị trộm) → gỡ mọi máy', async () => {
    const email = 'reuse@push.local'
    await registerUser(app, email)
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)
    const u: TestUser = {
      token: login.body.data.tokens.accessToken,
      id: login.body.data.user.id,
      email,
    }
    await register(u, newToken()).expect(200)
    const stolen = login.body.data.tokens.refreshToken

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: stolen }).expect(200)
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: stolen }).expect(401)
    expect(await devicesOf(u.id)).toHaveLength(0)
  })

  it('master khoá tài khoản → gỡ mọi máy', async () => {
    const u = await registerUser(app, 'locked@push.local')
    await register(u, newToken()).expect(200)

    await request(app)
      .patch(`/api/v1/users/${u.id}/status`)
      .set(bearer(master))
      .send({ isActive: false, reason: 'Đăng tin rác hàng loạt' })
      .expect(200)
    expect(await devicesOf(u.id)).toHaveLength(0)
  })

  it('xoá tài khoản → gỡ mọi máy và mọi push chưa đi', async () => {
    const u = await registerUser(app, 'deleted@push.local')
    await register(u, newToken()).expect(200)
    await PushOutbox.create({
      userId: u.id,
      category: 'chat',
      title: 'A',
      body: 'B',
      data: { path: null, notificationId: null, conversationId: null },
      nextAttemptAt: new Date(Date.now() + 60_000),
    })

    await request(app).delete('/api/v1/users/me').set(bearer(u)).expect(200)
    expect(await devicesOf(u.id)).toHaveLength(0)
    expect(await PushOutbox.countDocuments({ userId: u.id })).toBe(0)
  })
})

describe('Push thử', () => {
  it('server chưa bật push → 503', async () => {
    const u = await registerUser(app, 'test-off@push.local')
    await request(app).post('/api/v1/push/test').set(bearer(u)).expect(503)
  })

  it('bật: trả số máy; có máy thì xếp một dòng `account` về đúng người', async () => {
    vi.spyOn(pushConfig, 'enabled').mockReturnValue(true)
    const u = await registerUser(app, 'test-on@push.local')

    const none = await request(app).post('/api/v1/push/test').set(bearer(u)).expect(200)
    expect(none.body.data.devices).toBe(0)

    await register(u, newToken()).expect(200)
    const one = await request(app).post('/api/v1/push/test').set(bearer(u)).expect(200)
    expect(one.body.data.devices).toBe(1)
    const rows = await PushOutbox.find({ userId: u.id }).lean().exec()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'account', status: 'pending' })
  })
})
