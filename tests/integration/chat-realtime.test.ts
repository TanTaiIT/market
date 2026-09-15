import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  listingPayload,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Tín hiệu realtime khi có tin nhắn mới.
 *
 * Test theo dõi tầng `sockets/emit` chứ không dựng socket server thật, và đó là chủ ý: việc
 * socket.io giao gói tin tới đúng phòng là hành vi của thư viện. Thứ CÓ THỂ SAI ở đây là luật
 * nghiệp vụ — ai được báo, ai không, và báo bằng sự kiện nào.
 *
 * Ba điều được canh, tương ứng ba cách hỏng đã thấy trong thiết kế cũ:
 *
 * 1. Người nhận phải nhận `chat:inbox` ở phòng RIÊNG — phòng hội thoại chỉ tới được người đang
 *    mở đúng màn chat đó, nên bản cũ im lặng với người đang ở bảng tin.
 * 2. Người GỬI không được nhận — `send` vừa `markRead` cho họ, báo về là huy hiệu chưa đọc của
 *    chính mình sáng lên vì tin của chính mình.
 * 3. Payload không mang nội dung tin nhắn.
 */

const emitSpy = vi.hoisted(() => ({
  toUser: vi.fn(),
  toConversation: vi.fn(),
}))

vi.mock('../../src/sockets/emit', () => ({
  setSocketServer: vi.fn(),
  conversationRoom: (id: string) => `conversation:${id}`,
  userRoom: (id: string) => `user:${id}`,
  adminRoom: (id: string) => `org:${id}:admin`,
  emitToOrgAdmins: vi.fn(),
  emitToUser: emitSpy.toUser,
  emitToConversation: emitSpy.toConversation,
}))

let app: Application
let mongod: MongoMemoryReplSet

let seller: TestUser
let buyer: TestUser
let listingId = ''
let conversationId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const categoryId = await createCategory('Đồ dùng', 'do-dung')
  seller = await registerUser(app, 'ban@realtime.local', 'Người bán')
  buyer = await registerUser(app, 'mua@realtime.local', 'Người mua')

  const listing = await request(app)
    .post('/api/v1/listings')
    .set({ Authorization: `Bearer ${seller.token}` })
    .send({
      ...listingPayload('Xe đạp cũ', categoryId),
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  listingId = listing.body.data._id

  const chat = await request(app)
    .post('/api/v1/chats')
    .set({ Authorization: `Bearer ${buyer.token}` })
    .send({ listingId })
    .expect(201)
  conversationId = chat.body.data.id ?? chat.body.data._id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(() => {
  emitSpy.toUser.mockClear()
  emitSpy.toConversation.mockClear()
})

const send = (who: TestUser, text: string) =>
  request(app)
    .post(`/api/v1/chats/${conversationId}/messages`)
    .set({ Authorization: `Bearer ${who.token}` })
    .send({ text })

describe('Tin nhắn mới báo được cho người đang ở màn khác', () => {
  it('người NHẬN được báo ở phòng riêng, người GỬI thì không', async () => {
    await send(buyer, 'Xe còn không anh?').expect(201)

    // Đúng một lượt báo, và đúng người bán.
    expect(emitSpy.toUser).toHaveBeenCalledTimes(1)
    const [userId, event] = emitSpy.toUser.mock.calls[0]
    expect(userId).toBe(seller.id)
    expect(event).toBe('chat:inbox')

    // Người gửi KHÔNG nằm trong danh sách được báo.
    const notified = emitSpy.toUser.mock.calls.map((c) => c[0])
    expect(notified).not.toContain(buyer.id)
  }, 60_000)

  it('vẫn phát `chat:message` vào phòng hội thoại — hai sự kiện, hai người nghe', async () => {
    await send(seller, 'Còn em nhé').expect(201)

    expect(emitSpy.toConversation).toHaveBeenCalledTimes(1)
    expect(emitSpy.toConversation.mock.calls[0][1]).toBe('chat:message')

    // Và chiều ngược lại: giờ người mua là người được báo.
    expect(emitSpy.toUser.mock.calls[0][0]).toBe(buyer.id)
  }, 60_000)

  /**
   * Payload mỏng là một chốt về dữ liệu, không phải tối ưu băng thông: gói này tới được thiết
   * bị đang khoá màn hình và đi qua mọi proxy trên đường. Nội dung tin nhắn thì client hỏi lại
   * bằng REST khi người dùng thật sự mở hội thoại ra.
   */
  it('payload KHÔNG mang nội dung tin nhắn', async () => {
    await send(buyer, 'Địa chỉ nhà anh ở đâu ạ, em qua xem').expect(201)

    const payload = emitSpy.toUser.mock.calls[0][2] as Record<string, unknown>
    expect(payload.conversationId).toBe(conversationId)
    expect(payload.senderName).toBe('Người mua')
    expect(payload.at).toBeTypeOf('string')

    // Không có field nào chứa nội dung — kể cả dưới tên khác.
    expect(JSON.stringify(payload)).not.toContain('Địa chỉ nhà anh')
    expect(payload).not.toHaveProperty('text')
    expect(payload).not.toHaveProperty('preview')
  }, 60_000)
})
