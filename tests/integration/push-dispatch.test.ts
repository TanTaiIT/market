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
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'
import { pushConfig, pushService } from '../../src/features/push/push.service'
import { pushDispatcher } from '../../src/features/push/push.dispatcher'
import { pushRepository } from '../../src/features/push/push.repository'
import { PushDevice, PushOutbox } from '../../src/features/push/push.model'
import { expoPushClient } from '../../src/features/push/push.client'
import { PUSH_LIMITS } from '../../src/features/push/push.policy'

/**
 * Đường gửi push (push-notification.plan.md §3.2–3.5, §4.3): sự kiện nghiệp vụ → outbox →
 * dispatcher → Expo → receipt. Expo được mock ở tầng client — test khẳng định ĐÚNG tin nào đi
 * tới ĐÚNG máy nào, không đo mạng.
 */
vi.mock('../../src/features/push/push.client', () => ({
  expoPushClient: { send: vi.fn(), receipts: vi.fn() },
}))

const send = vi.mocked(expoPushClient.send)
const receipts = vi.mocked(expoPushClient.receipts)

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let owner: TestUser
let categoryId = ''
let orgId = ''
const ORG = 'nhom-push'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const newToken = () => `ExponentPushToken[dispatch${(seq += 1).toString().padStart(6, '0')}]`

/** Expo nhận hết: mỗi tin một ticket `ok`. */
function expoAcceptsAll() {
  send.mockImplementation(async (messages) => ({
    ok: true,
    value: messages.map((_, i) => ({ status: 'ok' as const, id: `ticket-${seq}-${i}` })),
  }))
}

async function member(email: string, opts: { device?: boolean } = {}) {
  const u = await registerUser(app, email, `Người ${email.split('@')[0]}`)
  await addMember(u.id, orgId)
  await setTrustLevel(u.id, 1)
  let token: string | null = null
  if (opts.device ?? true) {
    token = newToken()
    await request(app)
      .post('/api/v1/push/devices')
      .set(bearer(u))
      .send({ token, platform: 'android' })
      .expect(200)
  }
  return { ...u, pushToken: token }
}

async function postPending(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(title, categoryId), reach: 'members' })
    .expect(201)
  expect(res.body.data.status).toBe('pending')
  return res.body.data._id as string
}

const approve = (id: string) =>
  request(app)
    .patch(`/api/v1/moderation/listings/${id}`)
    .set(orgAuth(owner.token, ORG))
    .send({ status: 'active' })
    .expect(200)

const outboxOf = (userId: string) =>
  PushOutbox.find({ userId }).sort({ createdAt: 1 }).lean().exec()
const later = (ms: number) => new Date(Date.now() + ms)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung-push')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@push-dispatch.local', 'Chủ nhóm')
  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm push', key: ORG, ownerEmail: owner.email })
  ).id
}, 120_000)

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(pushConfig, 'enabled').mockReturnValue(true)
  send.mockReset()
  receipts.mockReset()
  expoAcceptsAll()
  // Mỗi test đọc outbox của chính nó — dọn dòng còn tồn để lượt claim không vớ phải dòng cũ.
  await PushOutbox.deleteMany({}).exec()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Sự kiện → outbox', () => {
  it('tin được duyệt → một dòng `listing_status` cho người đăng, dẫn thẳng vào tin', async () => {
    const seller = await member('seller1@push.local')
    const id = await postPending(seller, 'Bàn học gỗ thông')
    await approve(id)

    const rows = await outboxOf(seller.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: 'listing_status',
      title: 'Tin của bạn đã được duyệt',
      status: 'pending',
      data: { path: `/listing/${id}` },
    })
    expect(rows[0].data.notificationId).toMatch(/^[0-9a-f]{24}$/)
  }, 60_000)

  it('người chưa cài app (không có máy) → không tốn dòng outbox nào', async () => {
    const seller = await member('nodevice@push.local', { device: false })
    await approve(await postPending(seller, 'Ghế xoay văn phòng'))
    expect(await outboxOf(seller.id)).toHaveLength(0)
  }, 60_000)

  it('push tắt trên server → không ghi gì, nghiệp vụ vẫn chạy', async () => {
    vi.mocked(pushConfig.enabled).mockReturnValue(false)
    const seller = await member('disabled@push.local')
    await approve(await postPending(seller, 'Kệ sách ba tầng'))
    expect(await outboxOf(seller.id)).toHaveLength(0)
  }, 60_000)

  it('ghi outbox lỗi KHÔNG làm hỏng thao tác duyệt tin', async () => {
    const seller = await member('broken@push.local')
    const id = await postPending(seller, 'Đèn bàn LED')
    vi.spyOn(pushRepository, 'enqueue').mockRejectedValue(new Error('mongo down'))

    await approve(id)
    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(seller.token, ORG))
      .expect(200)
    expect(inbox.body.data.some((n: { title: string }) => n.title.includes('được duyệt'))).toBe(
      true,
    )
  }, 60_000)

  it('"X vừa đăng tin" (group_activity) tắt theo mặc định: chỉ người đã bật mới có dòng, trừ người đăng', async () => {
    const seller = await member('poster@push.local')
    const quiet = await member('quiet@push.local')
    const follower = await member('follower@push.local')
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(follower))
      .send({ categories: { group_activity: true } })
      .expect(200)
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(seller))
      .send({ categories: { group_activity: true } })
      .expect(200)

    await approve(await postPending(seller, 'Máy giặt cửa trước'))

    expect((await outboxOf(follower.id)).map((r) => r.category)).toEqual(['group_activity'])
    expect(await outboxOf(quiet.id)).toHaveLength(0)
    expect((await outboxOf(seller.id)).map((r) => r.category)).toEqual(['listing_status'])
  }, 60_000)

  it('quản trị gửi thông báo cho nhóm → mọi thành viên có máy nhận, trừ người soạn', async () => {
    const a = await member('notice-a@push.local')
    const b = await member('notice-b@push.local')
    await request(app).post('/api/v1/push/devices').set(bearer(owner)).send({
      token: newToken(),
      platform: 'ios',
    })

    await request(app)
      .post('/api/v1/notifications')
      .set(orgAuth(owner.token, ORG))
      .send({ title: 'Họp nhóm tối nay', body: '19h tại phòng sinh hoạt chung' })
      .expect(201)

    for (const u of [a, b]) {
      expect((await outboxOf(u.id)).map((r) => r.category)).toEqual(['group_notice'])
    }
    expect(await outboxOf(owner.id)).toHaveLength(0)
  }, 60_000)
})

describe('Dispatcher → Expo', () => {
  it('gửi đúng tin tới đúng máy; dòng thành `sent`, hẹn giờ đọc receipt', async () => {
    const seller = await member('send@push.local')
    const id = await postPending(seller, 'Tủ lạnh mini')
    await approve(id)

    // Người đã bật `group_activity` ở test trước cũng có dòng — chỉ soi tin tới máy người bán.
    await pushDispatcher.dispatchOnce()
    const messages = send.mock.calls.flatMap(([batch]) => batch)
    const mine = messages.filter((m) => m.to === seller.pushToken)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      to: seller.pushToken,
      title: 'Tin của bạn đã được duyệt',
      channelId: 'listing_status',
      data: { category: 'listing_status', path: `/listing/${id}` },
    })

    const [row] = await outboxOf(seller.id)
    expect(row.status).toBe('sent')
    expect(row.tickets).toHaveLength(1)
    expect(row.receiptsDueAt).toBeInstanceOf(Date)
  }, 60_000)

  it('tắt nhóm SAU khi đã xếp hàng → vẫn không gửi (lọc lúc gửi, không lúc ghi)', async () => {
    const seller = await member('prefoff@push.local')
    await approve(await postPending(seller, 'Nồi cơm điện'))
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(seller))
      .send({ categories: { listing_status: false } })
      .expect(200)

    await pushDispatcher.dispatchOnce()
    const sentTo = send.mock.calls.flatMap(([batch]) => batch.map((m) => m.to))
    expect(sentTo).not.toContain(seller.pushToken)
    const [row] = await outboxOf(seller.id)
    expect(row).toMatchObject({ status: 'skipped', lastError: 'pref_off' })
  }, 60_000)

  it('`account` đi kể cả khi người dùng tắt công tắc tổng', async () => {
    const u = await member('account@push.local')
    await request(app)
      .patch('/api/v1/push/preferences')
      .set(bearer(u))
      .send({ enabled: false })
      .expect(200)
    await pushService.notify([u.id], {
      category: 'account',
      title: 'Tài khoản của bạn đang bị quản chế',
      body: 'Tin mới cần duyệt tay trong 14 ngày.',
      path: null,
    })

    await pushDispatcher.dispatchOnce()
    expect((await outboxOf(u.id))[0].status).toBe('sent')
  }, 60_000)

  it('tài khoản bị khoá giữa chừng → bỏ qua', async () => {
    const u = await member('inactive@push.local')
    await pushService.notify([u.id], { category: 'wallet', title: 'Ví', body: '+5 Xu', path: null })
    const { User } = await import('../../src/features/user/user.model')
    await User.updateOne({ _id: u.id }, { isActive: false }).exec()

    await pushDispatcher.dispatchOnce()
    expect(send).not.toHaveBeenCalled()
    expect((await outboxOf(u.id))[0]).toMatchObject({
      status: 'skipped',
      lastError: 'user_inactive',
    })
  }, 60_000)

  it('ticket `DeviceNotRegistered` → tắt máy đó, dòng `failed` (gửi lại vô ích)', async () => {
    const u = await member('gone@push.local')
    send.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          status: 'error',
          message: 'not registered',
          details: { error: 'DeviceNotRegistered' },
        },
      ],
    })
    await pushService.notify([u.id], { category: 'wallet', title: 'Ví', body: '+5 Xu', path: null })

    await pushDispatcher.dispatchOnce()
    expect((await outboxOf(u.id))[0].status).toBe('failed')
    const device = await PushDevice.findOne({ token: u.pushToken }).lean().exec()
    expect(device?.disabledAt).toBeInstanceOf(Date)
  }, 60_000)

  it('Expo sập → lùi dần 1/5/15 phút, hết lượt thì `failed`', async () => {
    const u = await member('flaky@push.local')
    send.mockResolvedValue({ ok: false, message: 'HTTP 503' })
    await pushService.notify([u.id], { category: 'wallet', title: 'Ví', body: '+5 Xu', path: null })

    await pushDispatcher.dispatchOnce()
    let [row] = await outboxOf(u.id)
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 503' })
    const firstDelay = row.nextAttemptAt.getTime() - Date.now()
    expect(firstDelay).toBeGreaterThan(50_000)
    expect(firstDelay).toBeLessThanOrEqual(60_000)

    // Chưa tới hạn thì không gửi lại.
    expect((await pushDispatcher.dispatchOnce()).claimed).toBe(0)

    // Mỗi lượt ở một mốc xa hơn hẳn hạn retry trước đó.
    for (let i = 1; i < PUSH_LIMITS.MAX_ATTEMPTS; i += 1) {
      await pushDispatcher.dispatchOnce(later(i * 60 * 60_000))
    }
    ;[row] = await outboxOf(u.id)
    expect(row).toMatchObject({ status: 'failed', attempts: PUSH_LIMITS.MAX_ATTEMPTS })
    expect(send).toHaveBeenCalledTimes(PUSH_LIMITS.MAX_ATTEMPTS)
  }, 60_000)

  it('hai dispatcher chạy cùng lúc → mỗi dòng đi đúng một lần', async () => {
    const users = await Promise.all([1, 2, 3, 4, 5].map((i) => member(`race${i}@push.local`)))
    await pushService.notify(
      users.map((u) => u.id),
      { category: 'group_notice', title: 'Họp', body: 'Tối nay', path: null },
    )

    await Promise.all([pushDispatcher.dispatchOnce(), pushDispatcher.dispatchOnce()])
    const sentTo = send.mock.calls.flatMap(([messages]) => messages.map((m) => m.to))
    expect(sentTo.sort()).toEqual(users.map((u) => u.pushToken).sort())
  }, 60_000)

  it('receipt `DeviceNotRegistered` (máy đã gỡ app) → tắt máy, thôi hỏi receipt', async () => {
    const u = await member('receipt@push.local')
    send.mockResolvedValueOnce({ ok: true, value: [{ status: 'ok', id: 'ticket-gone' }] })
    await pushService.notify([u.id], { category: 'wallet', title: 'Ví', body: '+5 Xu', path: null })
    await pushDispatcher.dispatchOnce()

    receipts.mockResolvedValueOnce({
      ok: true,
      value: {
        'ticket-gone': {
          status: 'error',
          message: 'gone',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    })
    // Chưa tới hạn (15 phút) thì chưa hỏi.
    expect((await pushDispatcher.checkReceipts()).checked).toBe(0)
    expect(receipts).not.toHaveBeenCalled()

    const res = await pushDispatcher.checkReceipts(later(PUSH_LIMITS.RECEIPT_DELAY_MS + 1000))
    expect(res).toEqual({ checked: 1, dead: 1 })
    const device = await PushDevice.findOne({ token: u.pushToken }).lean().exec()
    expect(device?.disabledAt).toBeInstanceOf(Date)
    const [row] = await outboxOf(u.id)
    expect(row.receiptsDueAt).toBeNull()
    expect(row.tickets[0]).toMatchObject({ receiptChecked: true, error: 'DeviceNotRegistered' })
  }, 60_000)
})

describe('Chat — gộp tin dồn dập', () => {
  it('tin đầu đi ngay; tin trong 30 giây sau dồn vào MỘT push hẹn giờ, không kèm nội dung', async () => {
    const seller = await member('chat-seller@push.local')
    const buyer = await member('chat-buyer@push.local')
    const listingId = await postPending(seller, 'Xe đạp mini')
    await approve(listingId)
    await PushOutbox.deleteMany({}).exec()

    const conv = await request(app)
      .post('/api/v1/chats')
      .set(orgAuth(buyer.token, ORG))
      .send({ listingId })
      .expect(201)
    const say = (text: string) =>
      request(app)
        .post(`/api/v1/chats/${conv.body.data.id}/messages`)
        .set(orgAuth(buyer.token, ORG))
        .send({ text })
        .expect(201)

    await say('Xe còn không bạn?')
    let rows = await outboxOf(seller.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: 'chat',
      title: 'Người chat-buyer',
      body: 'Đã gửi cho bạn một tin nhắn',
      data: { path: `/chat/${conv.body.data.id}` },
    })
    expect(JSON.stringify(rows[0])).not.toContain('Xe còn không')
    await pushDispatcher.dispatchOnce()

    await say('Mình ở quận 1')
    await say('Chiều nay xem được không?')
    rows = await outboxOf(seller.id)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ status: 'pending', coalescedCount: 2, body: '2 tin nhắn mới' })
    // Hẹn giờ tới cuối cửa sổ gộp: bây giờ chưa đi.
    expect((await pushDispatcher.dispatchOnce()).claimed).toBe(0)
    expect(
      (await pushDispatcher.dispatchOnce(later(PUSH_LIMITS.CHAT_COALESCE_MS + 1000))).sent,
    ).toBe(1)
    // Người gửi không nhận push về tin của chính mình.
    expect(await outboxOf(buyer.id)).toHaveLength(0)
  }, 60_000)
})
