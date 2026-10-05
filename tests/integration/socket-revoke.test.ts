import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  grantRole,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { disconnectUser } from '../../src/sockets/emit'

/**
 * Audit 3.14 — socket đang mở giữ phòng (thành viên nhóm, quản trị) theo quyền LÚC BẮT TAY. Thu
 * hồi quyền mà không ngắt thì người đã bị gỡ vẫn nhận realtime của nhóm tới khi tự đóng app.
 * Ngắt là đủ: client tự nối lại và lượt bắt tay mới đọc quyền mới.
 *
 * Theo dõi tầng `sockets/emit` chứ không dựng socket thật (cùng cách `chat-realtime.test.ts`).
 */
vi.mock('../../src/sockets/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sockets/emit')>()),
  disconnectUser: vi.fn(),
}))

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let orgId = ''
const ORG = 'nhom-ngat-socket'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@socket.local', 'Chủ nhóm')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Nhóm ngắt socket',
      key: ORG,
      ownerEmail: owner.email,
    })
  ).id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Thu hồi quyền → ngắt socket của đúng người đó', () => {
  it('quản trị gỡ thành viên', async () => {
    const member = await registerUser(app, 'bi-go@socket.local', 'Bị gỡ')
    await addMember(member.id, orgId)

    await request(app)
      .delete(`/api/v1/memberships/${member.id}`)
      .set(orgAuth(owner.token, ORG))
      .expect(200)

    expect(disconnectUser).toHaveBeenCalledWith(member.id)
  }, 60_000)

  it('thành viên tự rời nhóm', async () => {
    const member = await registerUser(app, 'tu-roi@socket.local', 'Tự rời')
    await addMember(member.id, orgId)

    await request(app).post('/api/v1/memberships/leave').set(orgAuth(member.token, ORG)).expect(200)

    expect(disconnectUser).toHaveBeenCalledWith(member.id)
  }, 60_000)

  it('master thu hồi một grant', async () => {
    const mod = await registerUser(app, 'mod@socket.local', 'Người phụ trách')
    const grant = await grantRole({
      userId: mod.id,
      role: 'manager',
      scopeType: 'org',
      orgId,
    })

    await request(app).delete(`/api/v1/role-grants/${grant._id}`).set(bearer(master)).expect(200)

    expect(disconnectUser).toHaveBeenCalledWith(mod.id)
  }, 60_000)

  it('không ngắt ai khi thao tác không thu quyền của ai (gỡ người không phải thành viên → 404)', async () => {
    vi.mocked(disconnectUser).mockClear()
    const outsider = await registerUser(app, 'ngoai@socket.local', 'Người ngoài')

    await request(app)
      .delete(`/api/v1/memberships/${outsider.id}`)
      .set(orgAuth(owner.token, ORG))
      .expect(404)

    expect(disconnectUser).not.toHaveBeenCalled()
  }, 60_000)
})
