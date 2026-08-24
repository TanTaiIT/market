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
  setTrustLevel,
  seedBannedPhrases,
  startTestDb,
} from '../helpers/fixtures'
import { machineReviewService } from '../../src/features/moderation/moderation.machine.service'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
let orgId = ''
const ORG_SLUG = 'may-duyet'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  await seedBannedPhrases(master.id)
  seller = await registerUser(app, 'seller@machine.local', 'Người bán')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(seller.id, 0)

  // `ownerEmail` đã kèm membership cho seller — không addMember thêm kẻo trùng key.
  const org = await createOrg(app, master.token, {
    name: 'Org máy duyệt',
    slug: ORG_SLUG,
    ownerEmail: seller.email,
  })
  orgId = org.id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

async function post(body: Record<string, unknown>) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG_SLUG))
    .send({
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      ...body,
    })
    .expect(201)
  return res.body.data._id as string
}

async function readListing(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đọc phán quyết máy', () =>
    Listing.findById(id).select('status machineReview moderation').lean().exec(),
  )
}

async function trustOf(userId: string) {
  const { trustRepository } = await import('../../src/features/trust/trust.repository')
  return trustRepository.levelOf(userId)
}

describe('Người duyệt máy — vòng đời qua job', () => {
  it('tin sạch được máy đưa lên bảng, có báo cho người đăng, KHÔNG cộng uy tín', async () => {
    const id = await post({ title: 'Đèn học chống cận có kẹp bàn' })
    expect((await readListing(id))?.status).toBe('pending')

    const result = await machineReviewService.sweep()
    expect(result.approved).toBeGreaterThanOrEqual(1)

    const doc = await readListing(id)
    expect(doc?.status).toBe('active')
    expect(doc?.machineReview).toMatchObject({ verdict: 'approved' })

    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(seller.token, ORG_SLUG))
      .expect(200)
    expect(
      inbox.body.data.some((n: { title: string }) => n.title === 'Tin của bạn đã được duyệt'),
    ).toBe(true)

    // Điều kiện thiết kế: máy duyệt không phải "người thật đã nhìn" — bậc uy tín đứng im.
    expect(await trustOf(seller.id)).toBe(0)
  }, 60_000)

  it('tin chứa cụm cấm bị máy từ chối kèm lý do, và cũng KHÔNG trừ bậc uy tín', async () => {
    // Cổng nội dung (content-gate.test.ts) đã chặn cụm cấm ngay từ cửa, nên tin cấm không còn
    // vào được hàng đợi qua API. Nhánh reject của máy tồn tại cho kịch bản khác: cụm cấm được
    // THÊM VÀO DANH SÁCH sau khi tin đã nằm chờ — mô phỏng bằng cách sửa thẳng ở tầng model.
    const id = await post({ title: 'Hàng độc cho dân chơi' })
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    await runUnscoped('test: giả lập cụm cấm mới thêm sau khi tin đã vào hàng đợi', () =>
      Listing.updateOne({ _id: id }, { description: 'Có kèm pháo nổ tự chế số lượng lớn' }).exec(),
    )

    await machineReviewService.sweep()

    const doc = await readListing(id)
    expect(doc?.status).toBe('rejected')
    expect(doc?.machineReview).toMatchObject({ verdict: 'rejected' })
    expect(doc?.moderation).toMatchObject({ byName: 'Hệ thống' })
    expect(doc?.moderation?.reason).toContain('pháo nổ')
    // `moderation.at` phải có — `countRecentRejections` đếm bằng field này, chính nó là hình
    // phạt thật của lượt từ chối máy (khoá tự-đăng + bóp quota), thay cho việc trừ bậc.
    expect(doc?.moderation?.at).toBeTruthy()
    expect(await trustOf(seller.id)).toBe(0)

    const inbox = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(seller.token, ORG_SLUG))
      .expect(200)
    expect(inbox.body.data.some((n: { body: string }) => n.body.includes('pháo nổ'))).toBe(true)
  }, 60_000)

  it('người vừa bị từ chối thì tin sau máy GIỮ LẠI cho người thật, và không chấm lại lần hai', async () => {
    // Lượt từ chối ở test trước còn trong cửa sổ 7 ngày — đúng tình huống cần người thật nhìn.
    const id = await post({ title: 'Tin ngay sau lượt bị từ chối' })

    await machineReviewService.sweep()

    const doc = await readListing(id)
    expect(doc?.status).toBe('pending')
    expect(doc?.machineReview).toMatchObject({ verdict: 'held' })
    expect(doc?.machineReview?.holds).toContain('recent_rejection')

    // Dấu đã-chấm chặn job xử lại cùng tin đó mỗi lượt quét.
    const second = await machineReviewService.sweep()
    expect(second.scanned).toBe(0)
  }, 60_000)

  it('sửa nội dung tin đang bị giữ thì dấu máy bị xoá — job chấm lại bản mới', async () => {
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const held = await runUnscoped('test tìm tin đang held', () =>
      Listing.findOne({ 'machineReview.verdict': 'held' }).lean().exec(),
    )

    await request(app)
      .patch(`/api/v1/listings/${held!._id}`)
      .set(orgAuth(seller.token, ORG_SLUG))
      .send({ title: 'Tiêu đề đã đổi sau khi bị giữ' })
      .expect(200)

    expect((await readListing(held!._id.toString()))?.machineReview).toBeNull()
    const result = await machineReviewService.sweep()
    expect(result.scanned).toBe(1)
  }, 60_000)

  it('tin của người ngoài (pending_unverified) máy không được đụng tới', async () => {
    // Seller chính đã dính án từ chối nên quota bóp còn 1 chỗ — người này sạch tiểu sử.
    const fresh = await registerUser(app, 'fresh@machine.local', 'Người bán sạch')
    await setTrustLevel(fresh.id, 0)
    await addMember(fresh.id, orgId)
    const created = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(fresh.token, ORG_SLUG))
      .send({
        title: 'Tin giả làm người ngoài để thử máy',
        description: 'Mô tả đủ dài cho zod schema đi qua',
        price: 150000,
        categoryId,
        images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
        location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      })
      .expect(201)
    const id = created.body.data._id as string
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    await runUnscoped('test ép trạng thái người ngoài', () =>
      Listing.updateOne({ _id: id }, { status: 'pending_unverified', machineReview: null }).exec(),
    )

    await machineReviewService.sweep()

    expect((await readListing(id))?.status).toBe('pending_unverified')
  }, 60_000)
})

/**
 * Smoke cho phần nối Agenda: constructor v6 + backend rời là chỗ duy nhất typecheck không đủ —
 * API của nó đã đổi giữa các major. Chỉ cần start/stop sống sót trên Mongo thật là đạt;
 * còn logic job đã được test thẳng qua `sweep()` ở trên.
 */
describe('Agenda — nối scheduler', () => {
  it('startAgenda đăng ký được job rồi stopAgenda nhả lock, không nổ', async () => {
    const { startAgenda, stopAgenda } = await import('../../src/config/agenda')
    await startAgenda()

    const jobs = await mongoose.connection
      .db!.collection('agendaJobs')
      .find({ name: 'machine-review:sweep' })
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].repeatInterval).toBeTruthy()

    await stopAgenda()
  }, 60_000)
})
