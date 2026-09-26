import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createOrgUnit,
  createTestApp,
  grantRole,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * Thân phận (`Membership`) và quyền (`RoleGrant`) trong một org là MỘT CẶP — audit 3.2 và 3.3.
 *
 * Trước bản sửa chúng tách rời ở ba chỗ: `grantAdmin` bỏ qua `canGrant` nên master tự trao
 * được cho mình; `POST /role-grants` scope org tạo quyền mà không tạo thân phận ("admin rỗng
 * ruột" vắng mặt trong danh bạ); và gỡ khỏi danh bạ để nguyên quyền — người bị gỡ vẫn mở được
 * bàn duyệt của nhóm mình không còn đứng trong.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let categoryId = ''
const ORG = 'nhom-grant-membership'
let unitId = ''
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function newUser(inOrg: boolean, unit: string | null = null) {
  seq += 1
  const u = await registerUser(app, `user-${seq}@gm.local`, `Người ${seq}`)
  if (inOrg) await addMember(u.id, orgIdOf(ORG), { unitId: unit })
  return u
}

async function rosterRole(userId: string) {
  const res = await request(app)
    .get('/api/v1/memberships')
    .set(orgAuth(owner.token, ORG))
    .expect(200)
  return (res.body.data as { userId: string; role: string }[]).find((m) => m.userId === userId)
    ?.role
}

const desk = (u: TestUser) =>
  request(app).get('/api/v1/moderation/listings').set(orgAuth(u.token, ORG))

async function activeGrantsOf(userId: string) {
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  return RoleGrant.find({ userId, revokedAt: null }).lean().exec()
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@gm.local', 'Chủ nhóm')
  await createOrg(app, master.token, {
    name: 'Nhóm GM',
    key: ORG,
    ownerEmail: owner.email,
    orgType: 'school',
  })
  unitId = await createOrgUnit(orgIdOf(ORG), '10A1')
  void categoryId
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('3.3 — hai đường cấp quyền quản trị nhóm ra cùng một kết quả', () => {
  it('master KHÔNG tự trao quyền quản trị nhóm cho chính mình → 403', async () => {
    await request(app)
      .post(`/api/v1/organizations/${orgIdOf(ORG)}/admin`)
      .set(bearer(master))
      .send({ email: master.email })
      .expect(403)
    expect(await rosterRole(master.id)).toBeUndefined()
  }, 60_000)

  it('`POST /role-grants` scope org cho người NGOÀI nhóm → có mặt trong danh bạ với nhãn admin', async () => {
    const outsider = await newUser(false)
    const res = await request(app)
      .post('/api/v1/role-grants')
      .set(bearer(master))
      .send({ userEmail: outsider.email, role: 'manager', scopeType: 'org', orgId: orgIdOf(ORG) })
      .expect(201)

    expect(await rosterRole(outsider.id)).toBe('admin')
    await desk(outsider).expect(200)

    // Thu hồi grant → nhãn về `member`, và bàn duyệt đóng lại.
    await request(app)
      .delete(`/api/v1/role-grants/${res.body.data.id}`)
      .set(bearer(master))
      .expect(200)
    expect(await rosterRole(outsider.id)).toBe('member')
    await desk(outsider).expect(403)
  }, 60_000)

  it('`POST /role-grants` scope org cho thành viên THƯỜNG → nhãn nâng lên admin, không tạo membership thứ hai', async () => {
    const member = await newUser(true)
    expect(await rosterRole(member.id)).toBe('member')

    const granted = await request(app)
      .post('/api/v1/role-grants')
      .set(bearer(master))
      .send({ userEmail: member.email, role: 'manager', scopeType: 'org', orgId: orgIdOf(ORG) })
      .expect(201)

    expect(await rosterRole(member.id)).toBe('admin')
    // Trả lại trạng thái "một quản trị" cho các ca sau — ca chốt admin-cuối-cùng cần đúng điều đó.
    await request(app)
      .delete(`/api/v1/role-grants/${granted.body.data.id}`)
      .set(bearer(master))
      .expect(200)
    expect(await rosterRole(member.id)).toBe('member')
    const { Membership } = await import('../../src/features/membership/membership.model')
    expect(
      await Membership.countDocuments({ userId: member.id, organizationId: orgIdOf(ORG) }),
    ).toBe(1)
  }, 60_000)
})

describe('3.2 — gỡ khỏi danh bạ là thu hồi luôn quyền trong nhóm', () => {
  it('chủ nhóm gỡ staff nhóm con → grant org_unit bị thu hồi, bàn duyệt đóng', async () => {
    const staff = await newUser(true, unitId)
    await grantRole({
      userId: staff.id,
      role: 'staff',
      scopeType: 'org_unit',
      orgId: orgIdOf(ORG),
      unitId,
    })
    await desk(staff).expect(200)

    await request(app)
      .delete(`/api/v1/memberships/${staff.id}`)
      .set(orgAuth(owner.token, ORG))
      .expect(200)

    expect(await activeGrantsOf(staff.id)).toHaveLength(0)
    await desk(staff).expect(403)
  }, 60_000)

  it('master gỡ quản trị thứ hai → grant org bị thu hồi', async () => {
    const second = await newUser(false)
    await request(app)
      .post(`/api/v1/organizations/${orgIdOf(ORG)}/admin`)
      .set(bearer(master))
      .send({ email: second.email })
      .expect(200)
    await desk(second).expect(200)

    await request(app)
      .delete(`/api/v1/memberships/${second.id}`)
      .set(orgAuth(master.token, ORG))
      .expect(200)

    expect(await activeGrantsOf(second.id)).toHaveLength(0)
    await desk(second).expect(403)
    // Chủ nhóm ban đầu không bị ảnh hưởng.
    await desk(owner).expect(200)
  }, 60_000)

  it('quản trị DUY NHẤT vẫn không gỡ được — chốt cũ giữ nguyên', async () => {
    await request(app)
      .delete(`/api/v1/memberships/${owner.id}`)
      .set(orgAuth(master.token, ORG))
      .expect(409)
    expect(await activeGrantsOf(owner.id)).toHaveLength(1)
  }, 60_000)
})
