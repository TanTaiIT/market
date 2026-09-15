import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createTestApp,
  makeMaster,
  registerUser,
  seedBannedPhrases,
  startTestDb,
} from '../helpers/fixtures'
import { emitToUser } from '../../src/sockets/emit'

/*
 * Socket thật không chạy trong test HTTP (`startAgenda`/`initSockets` chỉ do `server.ts`
 * gọi), nên `emitToUser` vốn là no-op và không quan sát được. Thay nó bằng spy để kiểm
 * đúng thứ cần kiểm: master trả lời thì sự kiện có được bắn, và bắn tới ĐÚNG người.
 */
vi.mock('../../src/sockets/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sockets/emit')>()),
  emitToUser: vi.fn(),
}))

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let alice: TestUser
let bob: TestUser

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  await seedBannedPhrases(master.id)
  alice = await registerUser(app, 'alice@support.local', 'Alice')
  bob = await registerUser(app, 'bob@support.local', 'Bob')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

const send = (who: TestUser, body: string) =>
  request(app).post('/api/v1/support/me/messages').set(bearer(who)).send({ body })

const myThread = (who: TestUser) => request(app).get('/api/v1/support/me').set(bearer(who))

const reply = (threadId: string, body: string, who: TestUser = master) =>
  request(app).post(`/api/v1/support/threads/${threadId}/reply`).set(bearer(who)).send({ body })

const queue = (who: TestUser = master, query: Record<string, string> = {}) =>
  request(app).get('/api/v1/support/threads').query(query).set(bearer(who))

describe('Hỗ trợ — phía người dùng', () => {
  it('chưa nhắn gì thì trả luồng RỖNG, không phải 404', async () => {
    const res = await myThread(bob).expect(200)
    expect(res.body.data).toMatchObject({ id: null, messages: [], unread: false })
  }, 60_000)

  it('gửi tin đầu tiên tự tạo luồng', async () => {
    const res = await send(alice, 'Tôi không đăng được tin, app báo lỗi lạ').expect(200)
    expect(res.body.data.messages).toHaveLength(1)
    expect(res.body.data.messages[0]).toMatchObject({ from: 'user' })
  }, 60_000)

  it('gửi tiếp thì nối vào ĐÚNG luồng cũ, không đẻ luồng thứ hai', async () => {
    const first = (await myThread(alice).expect(200)).body.data.id
    await send(alice, 'Bổ sung: lỗi xảy ra ở bước chọn danh mục').expect(200)

    const after = await myThread(alice).expect(200)
    expect(after.body.data.id).toBe(first)
    expect(after.body.data.messages).toHaveLength(2)
  }, 60_000)

  it('nội dung quá ngắn bị từ chối', async () => {
    await send(bob, 'hi').expect(400)
  }, 60_000)

  /** Ô nhập tự do gửi thẳng tới người thật — cổng cụm từ cấm phải áp ở đây như mọi nơi khác. */
  it('cụm từ cấm bị chặn', async () => {
    const { BannedPhrase } = await import('../../src/features/banned-phrase/banned-phrase.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const phrase = await runUnscoped('test đọc cụm cấm', () =>
      BannedPhrase.findOne().select('phrase').lean().exec(),
    )
    if (!phrase) return

    const res = await send(bob, `Xin chào ${phrase.phrase} nhé bạn ơi`)
    expect(res.status).toBe(400)
  }, 60_000)
})

describe('Hỗ trợ — master trả lời', () => {
  it('luồng của người dùng nằm trong hàng đợi chờ xử lý', async () => {
    const res = await queue().expect(200)
    const mine = res.body.data.find((t: { userId: string }) => t.userId === alice.id)
    expect(mine).toBeTruthy()
    expect(mine.waiting).toBe(true)
    expect(mine.userName).toBe('Alice')
  }, 60_000)

  /**
   * Chấm đỏ trên icon là toàn bộ điểm của tính năng: người dùng phải BIẾT master đã trả lời mà
   * không cần mở ra kiểm tra.
   */
  it('master trả lời thì người dùng thấy unread', async () => {
    const threadId = (await myThread(alice).expect(200)).body.data.id

    const before = await myThread(alice).expect(200)
    expect(before.body.data.unread).toBe(false)

    await reply(threadId, 'Bạn thử cập nhật app lên bản mới nhất giúp mình nhé').expect(200)

    const after = await myThread(alice).expect(200)
    expect(after.body.data.unread).toBe(true)
    expect(after.body.data.messages.at(-1)).toMatchObject({ from: 'master' })
  }, 60_000)

  /**
   * Đường báo nhanh: không có nó thì chấm đỏ chỉ hiện ở nhịp polling kế tiếp.
   *
   * Kiểm cả NGƯỜI NHẬN chứ không chỉ "có gọi hay không": bắn nhầm phòng là rò một tín hiệu
   * riêng tư sang người khác, mà lỗi đó không có biểu hiện nào ở phía người đúng.
   */
  it('trả lời xong thì bắn sự kiện socket tới đúng người dùng của luồng', async () => {
    vi.mocked(emitToUser).mockClear()
    const threadId = (await myThread(alice).expect(200)).body.data.id

    await reply(threadId, 'Câu trả lời có kèm tín hiệu socket').expect(200)

    expect(emitToUser).toHaveBeenCalledTimes(1)
    const [userId, event] = vi.mocked(emitToUser).mock.calls[0]!
    expect(userId).toBe(alice.id)
    expect(event).toBe('support:reply')
    // KHÔNG bắn cho người khác — bob không liên quan tới luồng này.
    expect(userId).not.toBe(bob.id)
  }, 60_000)

  it('người dùng tự nhắn thì KHÔNG bắn sự kiện cho chính họ', async () => {
    vi.mocked(emitToUser).mockClear()
    await send(alice, 'Tin này của tôi, không cần ai đánh thức tôi cả').expect(200)
    expect(emitToUser).not.toHaveBeenCalled()
  }, 60_000)

  it('đọc xong thì tắt chấm đỏ, và nó không tự bật lại', async () => {
    await request(app).post('/api/v1/support/me/read').set(bearer(alice)).expect(200)

    expect((await myThread(alice).expect(200)).body.data.unread).toBe(false)
    // Người dùng nhắn thêm KHÔNG làm chấm đỏ của chính họ bật lên — nó chỉ báo tin từ master.
    await send(alice, 'Mình đã cập nhật rồi mà vẫn chưa được').expect(200)
    expect((await myThread(alice).expect(200)).body.data.unread).toBe(false)
  }, 60_000)

  it('master mở luồng ra đọc thì nó rời hàng đợi', async () => {
    const threadId = (await myThread(alice).expect(200)).body.data.id

    await request(app).get(`/api/v1/support/threads/${threadId}`).set(bearer(master)).expect(200)

    const waiting = await queue().expect(200)
    expect(waiting.body.data.map((t: { id: string }) => t.id)).not.toContain(threadId)

    // Nhưng vẫn tra ra được khi xem toàn bộ — mở ra đọc không phải là xoá.
    const all = await queue(master, { waiting: 'false' }).expect(200)
    expect(all.body.data.map((t: { id: string }) => t.id)).toContain(threadId)
  }, 60_000)

  it('mỗi người một luồng riêng, không thấy luồng của nhau', async () => {
    await send(bob, 'Mình muốn mở nhóm cho trường mình thì làm sao').expect(200)

    const aliceThread = (await myThread(alice).expect(200)).body.data
    const bobThread = (await myThread(bob).expect(200)).body.data

    expect(aliceThread.id).not.toBe(bobThread.id)
    expect(bobThread.messages).toHaveLength(1)
  }, 60_000)
})

describe('Hỗ trợ — cổng master', () => {
  it('người thường không đọc được hàng đợi', async () => {
    await queue(alice).expect(403)
  }, 60_000)

  it('người thường không trả lời thay master được', async () => {
    const threadId = (await myThread(bob).expect(200)).body.data.id
    await reply(threadId, 'Tôi giả làm admin đây', alice).expect(403)
  }, 60_000)

  it('người thường không đọc được luồng của người khác', async () => {
    const bobThreadId = (await myThread(bob).expect(200)).body.data.id
    await request(app).get(`/api/v1/support/threads/${bobThreadId}`).set(bearer(alice)).expect(403)
  }, 60_000)

  it('khách không token thì 401', async () => {
    await request(app).get('/api/v1/support/me').expect(401)
  }, 60_000)
})
