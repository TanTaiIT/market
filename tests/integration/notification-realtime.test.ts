import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Tín hiệu realtime của hộp thư thông báo.
 *
 * Như `chat-realtime`, test theo dõi tầng `sockets/emit` chứ không dựng socket thật: việc giao
 * gói tới đúng phòng là hành vi của socket.io, còn thứ CÓ THỂ SAI là luật — ai được báo.
 *
 * Ca đáng canh nhất là tin đăng mới của thành viên: thông báo đó là MỘT dòng `userId: null` cho
 * cả nhóm, nên tín hiệu phải đi vào phòng thành viên chứ không phòng cá nhân — và người đăng
 * phải bị LOẠI, vì `paginateInbox` cũng loại họ ở tầng đọc (`actorId != recipient`). Phát cho họ
 * là chuông kêu trong khi số chưa đọc không đổi: hai tầng nói hai chuyện khác nhau.
 */

const emitSpy = vi.hoisted(() => ({
  toUser: vi.fn(),
  toOrgMembers: vi.fn(),
  toConversation: vi.fn(),
}))

vi.mock('../../src/sockets/emit', () => ({
  setSocketServer: vi.fn(),
  conversationRoom: (id: string) => `conversation:${id}`,
  userRoom: (id: string) => `user:${id}`,
  orgMembersRoom: (id: string) => `org:${id}:members`,
  adminRoom: (id: string) => `org:${id}:admin`,
  emitToOrgAdmins: vi.fn(),
  emitToUser: emitSpy.toUser,
  emitToOrgMembers: emitSpy.toOrgMembers,
  emitToConversation: emitSpy.toConversation,
}))

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let categoryId = ''
let orgId = ''

const SLUG = 'nhom-notif-realtime'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  owner = await registerUser(app, 'chu@notif.local', 'Chủ nhóm')
  member = await registerUser(app, 'thanhvien@notif.local', 'Thành viên')

  const org = await createOrg(app, master.token, {
    name: 'Nhóm Notif',
    slug: SLUG,
    ownerEmail: owner.email,
  })
  orgId = org.id
  await addMember(member.id, orgId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(() => {
  emitSpy.toUser.mockClear()
  emitSpy.toOrgMembers.mockClear()
})

describe('Thông báo báo được cho người đang ở màn khác', () => {
  it('quản trị soạn thông báo → phát cho cả nhóm, KHÔNG loại ai', async () => {
    await request(app)
      .post('/api/v1/notifications')
      .set(orgAuth(owner.token, SLUG))
      .send({ title: 'Nghỉ lễ', body: 'Nhóm nghỉ ngày mai' })
      .expect(201)

    expect(emitSpy.toOrgMembers).toHaveBeenCalledTimes(1)
    const [org, event, , opts] = emitSpy.toOrgMembers.mock.calls[0]
    expect(org).toBe(orgId)
    expect(event).toBe('notif:new')
    /*
     * Người soạn KHÔNG bị loại, khác ca tin đăng bên dưới: dòng này không mang `actorId` nên
     * `paginateInbox` vẫn trả nó về cho chính họ. Loại ở đây là chuông im trong khi hộp thư
     * có thêm một dòng.
     */
    expect(opts?.exceptUserId).toBeUndefined()
  }, 60_000)

  it('thành viên đăng tin → phát cho nhóm và LOẠI chính người đăng', async () => {
    await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(member.token, SLUG))
      .send({ ...listingPayload('Bàn học cũ', categoryId), orgSlug: SLUG })
      .expect(201)

    expect(emitSpy.toOrgMembers).toHaveBeenCalledTimes(1)
    const [org, event, payload, opts] = emitSpy.toOrgMembers.mock.calls[0]
    expect(org).toBe(orgId)
    expect(event).toBe('notif:new')
    expect(opts?.exceptUserId).toBe(member.id)

    // Payload mỏng: nội dung thông báo không đi qua socket.
    expect(Object.keys(payload as object)).toEqual(['at'])
  }, 60_000)

  /**
   * Tin CÔNG KHAI không sinh thông báo nhóm — `notifyGroupOfListing` chặn ở `visibility`. Nếu
   * tín hiệu vẫn phát thì chuông của cả nhóm kêu cho một tin họ không hề nhận được.
   */
  it('tin công khai KHÔNG làm chuông cả nhóm kêu', async () => {
    await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${member.token}` })
      .send({
        ...listingPayload('Tin công khai', categoryId),
        visibility: 'public',
        provinceCode: 'Hồ Chí Minh',
      })
      .expect(201)

    expect(emitSpy.toOrgMembers).not.toHaveBeenCalled()
  }, 60_000)
})
