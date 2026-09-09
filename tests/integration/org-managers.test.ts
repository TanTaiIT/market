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

/**
 * `GET /organizations/:id/managers` — ai đang phụ trách một nhóm, cho bảng tổ chức của master.
 *
 * Lý do endpoint này tồn tại nằm ở ca thứ ba dưới đây: `grantAdmin` ghi CÙNG LÚC hai thứ —
 * `Membership.role = admin` (thân phận trong danh bạ) và một `RoleGrant` manager (quyền thật).
 * Thu hồi grant KHÔNG đụng tới `Membership.role`, nên đọc danh bạ sẽ nói "nhóm này có admin"
 * trong khi thực tế không còn ai quản được nó. Endpoint này đọc đúng nguồn giữ quyền.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let ownerA: TestUser
let outsider: TestUser
let orgId = ''

const SLUG = 'nhom-managers'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner@managers.local', 'Chủ nhóm')
  outsider = await registerUser(app, 'ngoai@managers.local', 'Người ngoài')

  const org = await createOrg(app, master.token, {
    name: 'Nhóm Managers',
    slug: SLUG,
    ownerEmail: ownerA.email,
  })
  orgId = org.id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const managers = (token?: string) => {
  const req = request(app).get(`/api/v1/organizations/${orgId}/managers`)
  return token ? req.set({ Authorization: `Bearer ${token}` }) : req
}

describe('Người phụ trách của một tổ chức', () => {
  it('master thấy người vừa được trao quyền, kèm mốc cấp', async () => {
    const res = await managers(master.token).expect(200)

    expect(res.body.data).toHaveLength(1)
    const [row] = res.body.data
    expect(row.userId).toBe(ownerA.id)
    expect(row.name).toBe('Chủ nhóm')
    expect(row.email).toBe(ownerA.email)
    expect(typeof row.grantedAt).toBe('string')
  }, 60_000)

  it('chỉ master đọc được — kể cả chính người phụ trách nhóm đó', async () => {
    // `ownerA` quản đúng nhóm này, nhưng bảng tổ chức là bàn của master.
    await managers(ownerA.token).expect(403)
    await request(app)
      .get(`/api/v1/organizations/${orgId}/managers`)
      .set(orgAuth(ownerA.token, SLUG))
      .expect(403)
    await managers(outsider.token).expect(403)
    await managers().expect(401)
  }, 60_000)

  it('org không tồn tại → 404, không phải mảng rỗng', async () => {
    await request(app)
      .get(`/api/v1/organizations/${new mongoose.Types.ObjectId().toString()}/managers`)
      .set({ Authorization: `Bearer ${master.token}` })
      .expect(404)
  }, 60_000)

  /**
   * Ca chính. Sau khi thu hồi grant:
   *   - endpoint này trả MẢNG RỖNG (không còn ai quản được nhóm),
   *   - còn `Membership.role` vẫn là `admin`.
   *
   * Nếu màn hình đọc danh bạ thay vì đọc đây, nó sẽ nói ngược lại đúng ở ca cần cảnh báo nhất.
   */
  it('thu hồi grant → danh sách rỗng, dù danh bạ vẫn ghi admin', async () => {
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const { Membership } = await import('../../src/features/membership/membership.model')

    await RoleGrant.updateMany(
      { userId: ownerA.id, scopeType: 'org' },
      { revokedAt: new Date(), revokedBy: null },
    ).exec()

    const res = await managers(master.token).expect(200)
    expect(res.body.data).toEqual([])

    const membership = await Membership.findOne({ userId: ownerA.id }).lean().exec()
    expect(membership?.role).toBe('admin')
  }, 60_000)

  /**
   * Grant còn hiệu lực mà tài khoản đã xoá: dòng VẪN hiện, chỉ thiếu tên.
   *
   * Lọc nó đi thì màn này báo "không còn ai phụ trách" trong khi bàn tổng quan — vốn chỉ đếm
   * grant — vẫn tính nhóm này là có manager. Hai chỗ trong cùng một bàn quản trị nói hai điều
   * trái nhau là thứ không ai lần ra nguyên nhân được.
   */
  it('grant trỏ tới tài khoản đã xoá vẫn thành một dòng, name/email = null', async () => {
    const ghost = await registerUser(app, 'ghost@managers.local', 'Sắp bị xoá')
    await request(app)
      .post(`/api/v1/organizations/${orgId}/admin`)
      .set({ Authorization: `Bearer ${master.token}` })
      .send({ email: ghost.email })
      .expect(200)

    const { User } = await import('../../src/features/user/user.model')
    await User.updateOne({ _id: ghost.id }, { deletedAt: new Date() }).exec()

    const res = await managers(master.token).expect(200)
    const row = res.body.data.find((r: { userId: string }) => r.userId === ghost.id)
    expect(row).toBeDefined()
    expect(row.name).toBeNull()
    expect(row.email).toBeNull()
  }, 60_000)
})
