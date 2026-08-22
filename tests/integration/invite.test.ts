import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let admin: TestUser
/** Đã có tài khoản → lời mời đích danh, đi qua thông báo trong app. */
let known: TestUser
/** Chưa có tài khoản lúc mời → chỉ còn link. */
const STRANGER_EMAIL = 'chua-co-tai-khoan@invite.local'

const SLUG = 'org-moi'
const asAdmin = () => orgAuth(admin.token, SLUG)

const invite = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/invites').set(asAdmin()).send(body)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const master = await makeMaster(app)
  admin = await registerUser(app, 'admin@invite.local', 'Quản trị')
  await createOrg(app, master.token, {
    name: 'Nhóm Mời',
    slug: SLUG,
    ownerEmail: admin.email,
  })

  known = await registerUser(app, 'daco@invite.local', 'Người đã có tài khoản')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Mời người đã có tài khoản', () => {
  let token = ''

  it('tra ra tài khoản thì lời mời là đích danh, không cần gửi link', async () => {
    const res = await invite({ channel: 'email', value: 'DaCo@Invite.Local' })

    expect(res.status).toBe(201)
    expect(res.body.data.invite).toMatchObject({ kind: 'direct', status: 'pending' })
    // Email chuẩn hoá về lowercase để so trùng không phụ thuộc cách gõ.
    expect(res.body.data.invite.value).toBe('daco@invite.local')
    expect(res.body.data.shareable).toBe(false)
    token = res.body.data.token
  })

  it('người được mời thấy nó trong hộp thư của mình, KHÔNG kèm địa chỉ', async () => {
    const res = await request(app)
      .get('/api/v1/invites/mine')
      .set('Authorization', `Bearer ${known.token}`)
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].organizationName).toBe('Nhóm Mời')
    expect(res.body.data[0].value).toBeUndefined()
  })

  it('người được mời cũng nhận thông báo trong app', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(known.token, SLUG))
      .expect(200)

    expect(res.body.data.map((n: { title: string }) => n.title)).toContain(
      'Bạn được mời vào một nhóm',
    )
  })

  it('người KHÁC cầm được token cũng không dùng được lời mời đích danh', async () => {
    const other = await registerUser(app, 'nguoi-khac@invite.local', 'Người khác')
    const res = await request(app)
      .post(`/api/v1/invites/token/${token}/accept`)
      .set('Authorization', `Bearer ${other.token}`)

    expect(res.status).toBe(403)
  })

  it('đúng người thì vào thẳng nhóm, không qua hàng đợi duyệt đơn', async () => {
    const res = await request(app)
      .post(`/api/v1/invites/token/${token}/accept`)
      .set('Authorization', `Bearer ${known.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.organizationSlug).toBe(SLUG)

    const roster = await request(app).get('/api/v1/memberships').set(asAdmin()).expect(200)
    expect(roster.body.data.map((m: { name: string }) => m.name)).toContain('Người đã có tài khoản')
  })

  it('dùng lại token đã nhận thì hỏng', async () => {
    const res = await request(app)
      .post(`/api/v1/invites/token/${token}/accept`)
      .set('Authorization', `Bearer ${known.token}`)

    expect(res.status).toBe(400)
  })

  it('đã là thành viên thì không mời lại được', async () => {
    const res = await invite({ channel: 'email', value: 'daco@invite.local' })
    expect(res.status).toBe(409)
  })
})

describe('Mời người chưa có tài khoản', () => {
  let token = ''

  it('không tra ra ai thì trả link để admin tự gửi', async () => {
    const res = await invite({ channel: 'email', value: STRANGER_EMAIL })

    expect(res.status).toBe(201)
    expect(res.body.data.invite.kind).toBe('link')
    expect(res.body.data.shareable).toBe(true)
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/)
    token = res.body.data.token
  })

  it('xem được thẻ lời mời mà chưa cần đăng nhập', async () => {
    const res = await request(app).get(`/api/v1/invites/token/${token}`).expect(200)

    expect(res.body.data.organizationName).toBe('Nhóm Mời')
    expect(res.body.data.memberCount).toBeGreaterThan(0)
  })

  it('mời trùng địa chỉ khi lời mời cũ còn chờ thì bị chặn', async () => {
    const res = await invite({ channel: 'email', value: STRANGER_EMAIL })
    expect(res.status).toBe(409)
  })

  it('ai cầm link cũng vào được — đó là bản chất của link mời', async () => {
    const anyone = await registerUser(app, 'bat-ky-ai@invite.local', 'Bất kỳ ai')
    const res = await request(app)
      .post(`/api/v1/invites/token/${token}/accept`)
      .set('Authorization', `Bearer ${anyone.token}`)

    expect(res.status).toBe(200)
  })
})

describe('Thu hồi và kiểm soát', () => {
  it('thu hồi xong thì link chết', async () => {
    const created = await invite({ channel: 'phone', value: '0909 123 456' }).expect(201)
    // Số điện thoại chuẩn hoá: bỏ khoảng trắng và dấu phân cách.
    expect(created.body.data.invite.value).toBe('0909123456')

    await request(app)
      .delete(`/api/v1/invites/${created.body.data.invite.id}`)
      .set(asAdmin())
      .expect(200)

    await request(app).get(`/api/v1/invites/token/${created.body.data.token}`).expect(400)
  })

  it('danh sách cho admin thấy đủ đã mời ai, trạng thái nào', async () => {
    const res = await request(app).get('/api/v1/invites').set(asAdmin()).expect(200)

    const statuses = res.body.data.map((row: { status: string }) => row.status)
    expect(statuses).toContain('accepted')
    expect(statuses).toContain('revoked')
  })

  it('thành viên thường không mời được ai', async () => {
    const member = await registerUser(app, 'thanhvien@invite.local', 'Thành viên')
    const { addMember } = await import('../helpers/fixtures')
    const { Organization } = await import('../../src/features/organization/organization.model')
    const org = await Organization.findOne({ slug: SLUG }).exec()
    await addMember(member.id, org!._id.toString())

    const res = await request(app)
      .post('/api/v1/invites')
      .set(orgAuth(member.token, SLUG))
      .send({ channel: 'email', value: 'ai-do@invite.local' })

    expect(res.status).toBe(403)
  })

  it('email sai định dạng bị chặn từ zod', async () => {
    const res = await invite({ channel: 'email', value: 'khong-phai-email' })
    expect(res.status).toBe(400)
  })
})
