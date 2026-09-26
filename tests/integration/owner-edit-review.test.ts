import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  listingPayload,
  makeMaster,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'
import { MACHINE_REVIEW } from '../../src/features/moderation/moderation.machine'
import { machineReviewService } from '../../src/features/moderation/moderation.machine.service'
import { listingExpiryService } from '../../src/features/listing/listing.expiry.service'

/**
 * Sửa tin đang/từng hiển thị phải đi qua ĐÚNG cổng như lúc đăng, và lên bảng là bắt đầu lại
 * hạn hiển thị.
 *
 * Ba lỗ đã đo được trước bản sửa:
 * 1. Người đủ bậc tự đăng: đăng sạch rồi PATCH giá lên 60 triệu — tin ở nguyên ACTIVE, không ai
 *    (người lẫn máy) xem lại, vì `update` chỉ xét uy tín còn máy quét chỉ nhìn hàng PENDING.
 * 2. Tin `expired` sửa nội dung rồi `renew` → ACTIVE, không qua lớp duyệt nào.
 * 3. Tin chờ duyệt quá 30 ngày vừa được duyệt đã bị job hết-hạn hạ xuống trong vòng một giờ.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Bậc trần — tự đăng thẳng lên bảng. */
let trusted: TestUser
/** Bậc 0 — mọi tin đều xếp hàng. */
let novice: TestUser
let categoryId = ''
const HCM = 'Hồ Chí Minh'
const OVER_CAP = MACHINE_REVIEW.MAX_AUTO_PRICE + 10_000_000

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function post(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(who))
    .send({ ...listingPayload(title, categoryId), reach: 'marketplace', provinceCode: HCM })
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

/** Đọc thẳng model — `autoApproval`/`expiresAt` không nằm trên DTO công khai. */
async function docOf(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đọc tin', () =>
    Listing.findById(id).select('status autoApproval expiresAt').lean().exec(),
  )
}

async function setDoc(id: string, patch: Record<string, unknown>) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test sửa tin', () => Listing.updateOne({ _id: id }, patch).exec())
}

const YESTERDAY = () => new Date(Date.now() - 24 * 60 * 60 * 1000)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-review')
  master = await makeMaster(app)
  trusted = await registerUser(app, 'trusted@review.local', 'Người bán uy tín')
  novice = await registerUser(app, 'novice@review.local', 'Người bán mới')
  await setTrustLevel(novice.id, 0)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Sửa tin ACTIVE của người đủ bậc tự đăng vẫn qua lớp FLAG', () => {
  it('đăng sạch tự lên bảng — làm mốc', async () => {
    const created = await post(trusted, 'Bàn học gỗ sồi')
    expect(created.status).toBe('active')
  })

  it('sửa giá vượt trần tự duyệt → tin xuống hàng đợi kèm lý do FLAG', async () => {
    const created = await post(trusted, 'Ghế xoay văn phòng')
    expect(created.status).toBe('active')

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ price: OVER_CAP })
      .expect(200)

    const doc = await docOf(created._id)
    expect(doc?.status).toBe('pending')
    expect(doc?.autoApproval).toMatchObject({ reason: 'content_flagged' })
    expect(doc?.autoApproval?.holds).toContain('price_over_cap')
  })

  it('sửa mô tả thành chuỗi gõ bừa cũng xuống hàng đợi', async () => {
    const created = await post(trusted, 'Tủ lạnh mini')

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ description: 'gggggghhljflkajsdlf qweqweqwe zxczxczxc asdasdasd' })
      .expect(200)

    const doc = await docOf(created._id)
    expect(doc?.status).toBe('pending')
    expect(doc?.autoApproval?.holds).toContain('gibberish')
  })

  it('sửa SẠCH thì tin ở nguyên trên bảng — cổng không đẻ việc thừa cho người duyệt', async () => {
    const created = await post(trusted, 'Máy hút bụi cầm tay')

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ title: 'Máy hút bụi cầm tay, còn bảo hành' })
      .expect(200)

    expect((await docOf(created._id))?.status).toBe('active')
  })
})

describe('Tin hết hạn sửa nội dung không lách được lớp duyệt', () => {
  it('người đủ bậc: sửa thành nội dung bị FLAG → pending, gia hạn bị chặn', async () => {
    const created = await post(trusted, 'Xe đạp thể thao')
    await setDoc(created._id, { status: 'expired', expiresAt: YESTERDAY() })

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ price: OVER_CAP })
      .expect(200)
    expect((await docOf(created._id))?.status).toBe('pending')

    // Đường vòng cũ: `renew` chỉ nhận active/expired, nên tin đã về hàng đợi thì không bật lên được.
    await request(app)
      .post(`/api/v1/listings/${created._id}/renew`)
      .set(bearer(trusted))
      .expect(400)
  })

  it('người bậc thấp: sửa tin hết hạn là xếp hàng lại, không tự quay lại bảng', async () => {
    // Tin từng được duyệt lúc uy tín còn cao, rồi người bán tụt bậc.
    const created = await post(trusted, 'Loa bluetooth')
    await setDoc(created._id, { status: 'expired', expiresAt: YESTERDAY() })
    await setTrustLevel(trusted.id, 0)

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ title: 'Loa bluetooth chính hãng' })
      .expect(200)
    expect((await docOf(created._id))?.status).toBe('pending')

    await request(app)
      .post(`/api/v1/listings/${created._id}/renew`)
      .set(bearer(trusted))
      .expect(400)
    await setTrustLevel(trusted.id, 2)
  })

  it('người đủ bậc sửa SẠCH tin hết hạn thì vẫn gia hạn được — như xoá đi đăng lại', async () => {
    const created = await post(trusted, 'Bếp từ đơn')
    await setDoc(created._id, { status: 'expired', expiresAt: YESTERDAY() })

    await request(app)
      .patch(`/api/v1/listings/${created._id}`)
      .set(bearer(trusted))
      .send({ title: 'Bếp từ đơn, mới 99%' })
      .expect(200)
    expect((await docOf(created._id))?.status).toBe('expired')

    const res = await request(app)
      .post(`/api/v1/listings/${created._id}/renew`)
      .set(bearer(trusted))
      .expect(200)
    expect(res.body.data.status).toBe('active')
  })
})

describe('Lên bảng là bắt đầu lại hạn hiển thị', () => {
  it('người duyệt tay duyệt tin chờ quá hạn → expiresAt mới, job hết-hạn không hạ nó', async () => {
    const created = await post(novice, 'Máy ảnh phim cũ')
    expect(created.status).toBe('pending')
    // Nằm chờ quá lâu — `expiresAt` tính từ lúc đăng đã trôi qua.
    await setDoc(created._id, { expiresAt: YESTERDAY() })

    await request(app)
      .patch(`/api/v1/moderation/listings/${created._id}`)
      .set(bearer(master))
      .send({ status: 'active' })
      .expect(200)

    const doc = await docOf(created._id)
    expect(doc?.status).toBe('active')
    expect(doc!.expiresAt!.getTime()).toBeGreaterThan(Date.now())

    await listingExpiryService.sweep()
    expect((await docOf(created._id))?.status).toBe('active')
  })

  it('máy duyệt cũng đặt lại hạn', async () => {
    const created = await post(novice, 'Đèn bàn LED')
    expect(created.status).toBe('pending')
    await setDoc(created._id, { expiresAt: YESTERDAY() })

    await machineReviewService.sweep()

    const doc = await docOf(created._id)
    expect(doc?.status).toBe('active')
    expect(doc!.expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })
})
