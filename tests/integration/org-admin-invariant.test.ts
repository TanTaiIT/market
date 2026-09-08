import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser

/**
 * BẤT BIẾN: mỗi tổ chức đang hoạt động phải luôn còn ít nhất một quản trị dùng được.
 *
 * Phía sinh ra vốn đã đúng (org mới ở `pending_admin`, chỉ `active` khi được trao quyền). Bộ
 * test này khoá phía NGƯỢC LẠI — ba đường có thể lấy đi người phụ trách cuối cùng: thu hồi
 * grant, gỡ khỏi danh bạ, và xoá tài khoản.
 *
 * Mỗi ca dựng org RIÊNG: các ca dưới đây xoá tài khoản và gỡ thành viên, dùng chung một org là
 * ca sau phụ thuộc thứ tự chạy của ca trước.
 */
beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

let seq = 0
/** Người dùng mới mỗi lần gọi — ca xoá tài khoản không tái dùng được người của ca khác. */
const someone = (name: string) => registerUser(app, `u${(seq += 1)}@inv.local`, name)

const orgWith = (slug: string, admin: TestUser) =>
  createOrg(app, master.token, { name: `Nhóm ${slug}`, slug, ownerEmail: admin.email })

const grantAdmin = (orgId: string, email: string) =>
  request(app)
    .post(`/api/v1/organizations/${orgId}/admin`)
    .set(bearer(master))
    .send({ email })
    .expect(200)

/** `role_grants` không mang `tenantPlugin` nên đọc thẳng, không cần scope. */
async function adminGrants(orgId: string) {
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  return RoleGrant.find({
    orgId,
    role: 'manager',
    scopeType: 'org',
    revokedAt: null,
  })
    .lean()
    .exec()
}

const grantIdOf = async (orgId: string, userId: string) => {
  const grants = await adminGrants(orgId)
  const mine = grants.find((g) => g.userId.toString() === userId)
  if (!mine) throw new Error('Không tìm thấy grant quản trị của người này')
  return mine._id.toString()
}

const revoke = (grantId: string) =>
  request(app).delete(`/api/v1/role-grants/${grantId}`).set(bearer(master))

describe('Thu hồi quyền — không bỏ trống ghế quản trị', () => {
  it('không thu hồi được quyền của quản trị DUY NHẤT', async () => {
    const alice = await someone('Alice')
    const org = await orgWith('inv-a', alice)

    const res = await revoke(await grantIdOf(org.id, alice.id)).expect(409)
    expect(res.body.message).toContain('quản trị duy nhất')

    // Chốt phải chặn TRƯỚC khi ghi: 409 mà grant đã bị thu hồi là mất bất biến kèm một lời từ chối.
    expect(await adminGrants(org.id)).toHaveLength(1)
  }, 60_000)

  it('thu hồi được khi nhóm còn quản trị khác', async () => {
    const bob = await someone('Bob')
    const carol = await someone('Carol')
    const org = await orgWith('inv-b', bob)
    await grantAdmin(org.id, carol.email)

    await revoke(await grantIdOf(org.id, bob.id)).expect(200)

    const left = await adminGrants(org.id)
    expect(left.map((g) => g.userId.toString())).toEqual([carol.id])
  }, 60_000)
})

describe('Gỡ khỏi danh bạ — thân phận và quyền không tách rời', () => {
  /**
   * Trước thay đổi này master gỡ được: membership bị lưu trữ mà grant vẫn hiệu lực, sinh ra một
   * "admin rỗng ruột" duyệt được tin của nhóm mà họ không còn là thành viên.
   */
  it('master cũng không gỡ được quản trị duy nhất khỏi danh bạ', async () => {
    const dave = await someone('Dave')
    const org = await orgWith('inv-c', dave)

    const res = await request(app)
      .delete(`/api/v1/memberships/${dave.id}`)
      .set(orgAuth(master.token, org.slug))
      .expect(409)
    expect(res.body.message).toContain('quản trị duy nhất')
  }, 60_000)

  it('vẫn gỡ được thành viên thường', async () => {
    const erin = await someone('Erin')
    const frank = await someone('Frank')
    const org = await orgWith('inv-d', erin)
    await addMember(frank.id, org.id)

    await request(app)
      .delete(`/api/v1/memberships/${frank.id}`)
      .set(orgAuth(master.token, org.slug))
      .expect(200)
  }, 60_000)
})

describe('Xoá tài khoản — đường tự phục vụ cũng không bỏ trống ghế', () => {
  /**
   * Đường này KHÔNG đi qua `roleGrantService.revoke` (nó gọi thẳng `revokeAllForUser`), nên nó
   * cần chốt riêng — đây là lỗ cuối cùng còn lại.
   */
  it('quản trị duy nhất không xoá được tài khoản, và lỗi nêu tên nhóm', async () => {
    const gina = await someone('Gina')
    const org = await orgWith('inv-e', gina)

    const res = await request(app).delete('/api/v1/users/me').set(bearer(gina)).expect(409)
    expect(res.body.message).toContain(org.name)

    expect(await adminGrants(org.id)).toHaveLength(1)
  }, 60_000)

  it('xoá được khi nhóm còn quản trị khác', async () => {
    const henry = await someone('Henry')
    const iris = await someone('Iris')
    const org = await orgWith('inv-f', henry)
    await grantAdmin(org.id, iris.email)

    await request(app).delete('/api/v1/users/me').set(bearer(henry)).expect(200)

    const left = await adminGrants(org.id)
    expect(left.map((g) => g.userId.toString())).toEqual([iris.id])
  }, 60_000)
})

describe('Phía sinh ra — org chưa có quản trị thì chưa hoạt động', () => {
  it('org mới tạo nằm ở pending_admin, chỉ active sau khi được trao quyền', async () => {
    const created = await request(app)
      .post('/api/v1/organizations')
      .set(bearer(master))
      .send({ name: 'Nhóm chưa có ai', slug: 'inv-g' })
      .expect(201)
    const orgId = created.body.data.id as string

    const { Organization } = await import('../../src/features/organization/organization.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const statusOf = () =>
      runUnscoped('test đọc status org', async () => {
        const doc = await Organization.findById(orgId).select('status').lean().exec()
        return doc?.status
      })

    expect(await statusOf()).toBe('pending_admin')

    const jane = await someone('Jane')
    await grantAdmin(orgId, jane.email)
    expect(await statusOf()).toBe('active')
  }, 60_000)
})
