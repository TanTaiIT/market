import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
  makeMaster,
  orgAuth,
  registerUser,
  seedBannedPhrases,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Người bậc 2 — nhân vật chính: cổng phải thắng được cả fast-path của họ. */
let trusted: TestUser
let categoryId = ''
let orgId = ''
const ORG_SLUG = 'cong-noi-dung'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  await seedBannedPhrases(master.id)
  trusted = await registerUser(app, 'trusted@gate.local', 'Người bậc hai')

  const org = await createOrg(app, master.token, {
    name: 'Org cổng nội dung',
    slug: ORG_SLUG,
    ownerEmail: trusted.email,
  })
  orgId = org.id
  await setTrustLevel(trusted.id, 2)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function post(who: TestUser, body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG_SLUG))
    .send({
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://example.com/a.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      ...body,
    })
}

async function readTrace(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đọc vết cổng nội dung', () =>
    Listing.findById(id).select('status autoApproval moderation').lean().exec(),
  )
}

describe('Cổng nội dung — BLOCK từ cửa', () => {
  it('bậc 2 đăng tin chứa cụm cấm → REJECTED ngay, fast-path bất lực', async () => {
    const res = await post(trusted, {
      title: 'Thanh lý nhanh trong tuần',
      description: 'Kèm sừng tê giác xịn cho khách quen',
    }).expect(201)
    expect(res.body.data.status).toBe('rejected')

    const doc = await readTrace(res.body.data._id)
    expect(doc?.autoApproval).toMatchObject({ trustLevel: 2, reason: 'content_banned' })
    expect(doc?.moderation).toMatchObject({ byName: 'Hệ thống' })
    expect(doc?.moderation?.reason).toContain('sừng tê giác')

    // Không bao giờ chạm bảng tin.
    const board = await request(app)
      .get('/api/v1/listings')
      .set(orgAuth(trusted.token, ORG_SLUG))
      .expect(200)
    expect(board.body.data.map((l: { _id: string }) => l._id)).not.toContain(res.body.data._id)

    // Người đăng được báo vì sao.
    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(trusted.token, ORG_SLUG))
      .expect(200)
    expect(inbox.body.data.some((n: { body: string }) => n.body.includes('sừng tê giác'))).toBe(
      true,
    )
  }, 60_000)

  it('án REJECTED từ cổng đóng luôn fast-path của tin sạch kế tiếp', async () => {
    const res = await post(trusted, { title: 'Tin sạch ngay sau lượt bị chặn' }).expect(201)

    expect(res.body.data.status).toBe('pending')
    const doc = await readTrace(res.body.data._id)
    expect(doc?.autoApproval).toMatchObject({ reason: 'recent_rejection' })
  }, 60_000)

  it('sửa tin nhét cụm cấm vào → 400 thẳng, nội dung cũ giữ nguyên', async () => {
    // Người sạch tiểu sử để tin lên bảng bằng fast-path thật.
    const clean = await registerUser(app, 'clean@gate.local', 'Người sạch án')
    await addMember(clean.id, orgId)
    await setTrustLevel(clean.id, 2)

    const created = await post(clean, { title: 'Đèn học chống cận có kẹp bàn' }).expect(201)
    expect(created.body.data.status).toBe('active')
    const id = created.body.data._id

    const res = await request(app)
      .patch(`/api/v1/listings/${id}`)
      .set(orgAuth(clean.token, ORG_SLUG))
      .send({ description: 'Cập nhật: có bán kèm pháo nổ' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('pháo nổ')

    expect((await readTrace(id))?.status).toBe('active')
  }, 60_000)
})

describe('Cổng nội dung — FLAG tước fast-path', () => {
  /** Mỗi test một người bậc 2 mới, khỏi dẫm án phạt của nhau. */
  async function freshTrusted(email: string) {
    const user = await registerUser(app, email, 'Người bậc hai sạch án')
    await addMember(user.id, orgId)
    await setTrustLevel(user.id, 2)
    return user
  }

  it('bậc 2 đăng tin giá vượt trần máy → xuống hàng đợi với reason content_flagged', async () => {
    const who = await freshTrusted('cap@gate.local')
    const res = await post(who, {
      title: 'Đồng hồ cơ Thuỵ Sĩ bản giới hạn',
      price: 60_000_000,
    }).expect(201)

    expect(res.body.data.status).toBe('pending')
    const doc = await readTrace(res.body.data._id)
    expect(doc?.autoApproval).toMatchObject({ trustLevel: 2, reason: 'content_flagged' })
  }, 60_000)

  it('bậc 2 đăng tin trùng tiêu đề với tin đang sống của chính mình → cũng bị tước', async () => {
    const who = await freshTrusted('dup@gate.local')
    const first = await post(who, { title: 'Ghế công thái học fullbox' }).expect(201)
    expect(first.body.data.status).toBe('active')

    const second = await post(who, { title: 'Ghế công thái học fullbox' }).expect(201)
    expect(second.body.data.status).toBe('pending')
    expect((await readTrace(second.body.data._id))?.autoApproval).toMatchObject({
      reason: 'content_flagged',
    })
  }, 60_000)

  it('bậc 2, tin sạch, giá thường → fast-path vẫn mở như cũ', async () => {
    const who = await freshTrusted('ok@gate.local')
    const res = await post(who, { title: 'Bàn phím cơ layout 75 phần trăm' }).expect(201)

    expect(res.body.data.status).toBe('active')
    expect((await readTrace(res.body.data._id))?.autoApproval).toMatchObject({
      reason: 'approved',
    })
  }, 60_000)
})
