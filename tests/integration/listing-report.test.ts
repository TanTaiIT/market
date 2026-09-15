import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { Listing } from '../../src/features/listing/listing.model'
import { bucketLabel } from '../../src/common/report/timeBuckets'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
const SLUG = 'bao-cao'
const HCM = 'Hồ Chí Minh'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ cũ', 'do-cu-report')
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@report.local', 'Người bán')
  await createOrg(app, master.token, {
    name: 'Nhóm báo cáo',
    slug: SLUG,
    ownerEmail: seller.email,
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

/** Tin CÔNG KHAI của người bán. */
async function postPublic(title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(seller))
    .send({ ...listingPayload(title, categoryId), visibility: 'public', provinceCode: HCM })
    .expect(201)
  return res.body.data._id as string
}

/** Tin NỘI BỘ nhóm — thứ mà scope của master (không kèm org) sẽ không thấy. */
async function postInternal(title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, SLUG))
    .send({ ...listingPayload(title, categoryId), visibility: 'org_internal' })
    .expect(201)
  return res.body.data._id as string
}

/**
 * Lùi ngày tạo để dựng chuỗi thời gian mà không phải chờ hết một ngày thật.
 *
 * Đi thẳng qua driver gốc (`.collection`), KHÔNG qua Mongoose: `timestamps: true` làm
 * `createdAt` thành immutable, nên Mongoose tước nó khỏi mọi update rồi trả về
 * `{ acknowledged: false }` — lệnh "thành công" mà không chạm tới DB, và test sẽ đo một chuỗi
 * thời gian mà mọi tin đều nằm ở hôm nay. `timestamps: false` trong options KHÔNG mở được
 * chốt này.
 *
 * Driver gốc không cast `_id`, nên phải tự dựng ObjectId.
 */
const backdate = (id: string, at: Date) =>
  Listing.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { createdAt: at } })

const report = (query: Record<string, string>, who: TestUser = master) =>
  request(app).get('/api/v1/listings/report').query(query).set(bearer(who))

describe('Báo cáo đăng tin — cổng', () => {
  it('người không thuộc nhóm nào không xem được — bản toàn hệ thống là của master', async () => {
    // `seller` KHÔNG dùng được cho ca này: họ thuộc đúng một nhóm nên `resolveTenant` tự suy ra
    // org và trả bản của nhóm — đó là hành vi đúng, không phải lỗ hổng.
    const nobody = await registerUser(app, 'nobody@report.local', 'Không nhóm')
    await report({ granularity: 'day' }, nobody).expect(403)
  }, 60_000)

  /**
   * Bản CỦA NHÓM: cùng endpoint, kèm `X-Org-Slug`, đếm mọi tin MANG DẤU NHÓM — nội bộ lẫn công
   * khai do thành viên đăng trong ngữ cảnh nhóm (khoá trục là `visibility`, không phải
   * `organizationId`). Tin công khai của người NGOÀI nhóm (`organizationId: null`) không tính:
   * nó làm bản toàn hệ thống nhích lên mà bản của nhóm đứng yên.
   */
  it('quản trị nhóm kèm org xem bản của nhóm — tin của người ngoài nhóm không được đếm', async () => {
    // Lùi cả hai tin về một ngày cũ RIÊNG: các test sau đếm cột "hôm nay" theo số người bán, thêm
    // một người ngoài vào hôm nay là làm lệch con số của họ.
    const DAY = new Date('2021-03-10T09:00:00.000Z')
    const window = { granularity: 'day', from: '2021-03-01', to: '2021-03-31' }
    await backdate(await postInternal('Nội bộ cho báo cáo nhóm'), DAY)
    const stranger = await registerUser(app, 'stranger@report.local', 'Người ngoài')
    const pub = await request(app)
      .post('/api/v1/listings')
      .set(bearer(stranger))
      .send({
        ...listingPayload('Công khai của người ngoài', categoryId),
        visibility: 'public',
        provinceCode: HCM,
      })
      .expect(201)
    await backdate(pub.body.data._id, DAY)

    const mine = await request(app)
      .get('/api/v1/listings/report')
      .query(window)
      .set(orgAuth(seller.token, SLUG))
      .expect(200)
    const all = await report(window).expect(200)

    const label = bucketLabel(DAY, 'day')
    const orgDay = mine.body.data.points.find((pt: { bucket: string }) => pt.bucket === label)
    const allDay = all.body.data.points.find((pt: { bucket: string }) => pt.bucket === label)
    expect(orgDay.posts).toBe(1)
    expect(allDay.posts).toBe(2)
  }, 60_000)

  it('khách không có token thì 401', async () => {
    await request(app).get('/api/v1/listings/report').expect(401)
  }, 60_000)
})

describe('Báo cáo đăng tin — chuỗi thời gian', () => {
  it('cột rỗng vẫn có mặt với số 0, đúng số cột yêu cầu', async () => {
    const today = bucketLabel(new Date(), 'day')
    const id = await postPublic('Tin hôm nay')

    const res = await report({ granularity: 'day' }).expect(200)
    const { points, granularity, timezone } = res.body.data

    expect(granularity).toBe('day')
    // Múi giờ phải nói ra: "ngày" ở đây là ngày Việt Nam, không phải ngày máy người xem.
    expect(timezone).toBe('Asia/Ho_Chi_Minh')
    expect(points).toHaveLength(30)
    expect(points.every((p: { bucket: string }) => p.bucket)).toBe(true)

    const last = points[points.length - 1]
    expect(last.bucket).toBe(today)
    expect(last.posts).toBeGreaterThanOrEqual(1)
    // Ngày đầu cửa sổ chưa có tin nào — phải là 0, không phải vắng mặt.
    expect(points[0].posts).toBe(0)
    expect(id).toBeTruthy()
  }, 60_000)

  /**
   * Ca chặn cho `runUnscoped` trong `reportSeries`: scope của một request master KHÔNG kèm org
   * chỉ mở trục công khai. Để `tenantPlugin` lọc là im lặng bỏ sót toàn bộ tin nội bộ của mọi
   * nhóm — báo cáo vẫn ra số, chỉ là sai, và không ai nhìn ra.
   */
  it('đếm CẢ tin nội bộ nhóm, không chỉ tin công khai', async () => {
    const before = (await report({ granularity: 'day' }).expect(200)).body.data.totals.posts

    await postInternal('Tin nội bộ nhóm')

    const after = (await report({ granularity: 'day' }).expect(200)).body.data.totals.posts
    expect(after).toBe(before + 1)
  }, 60_000)

  it('đếm người bán KHÁC NHAU, không phải số lượt đăng', async () => {
    const other = await registerUser(app, 'seller2@report.local', 'Người bán 2')
    await request(app)
      .post('/api/v1/listings')
      .set(bearer(other))
      .send({
        ...listingPayload('Tin người thứ hai', categoryId),
        visibility: 'public',
        provinceCode: HCM,
      })
      .expect(201)
    await postPublic('Thêm một tin nữa của người cũ')

    const res = await report({ granularity: 'day' }).expect(200)
    const today = res.body.data.points.at(-1)

    // Nhiều tin nhưng chỉ hai người bán trong ngày hôm nay.
    expect(today.sellers).toBe(2)
    expect(today.posts).toBeGreaterThan(today.sellers)
  }, 60_000)

  it('gộp theo tháng và theo năm', async () => {
    const old = await postPublic('Tin của năm ngoái')
    await backdate(old, new Date('2025-04-15T03:00:00Z'))

    const byMonth = await report({
      granularity: 'month',
      from: '2025-04-01T00:00:00.000Z',
      to: new Date().toISOString(),
    }).expect(200)
    const april = byMonth.body.data.points.find((p: { bucket: string }) => p.bucket === '2025-04')
    expect(april.posts).toBe(1)

    const byYear = await report({
      granularity: 'year',
      from: '2025-01-01T00:00:00.000Z',
      to: new Date().toISOString(),
    }).expect(200)
    const y2025 = byYear.body.data.points.find((p: { bucket: string }) => p.bucket === '2025')
    expect(y2025.posts).toBe(1)
  }, 60_000)

  it('xin khoảng quá dài thì cắt phần cũ và báo số cột đã cắt', async () => {
    const res = await report({
      granularity: 'day',
      from: '2019-01-01T00:00:00.000Z',
      to: new Date().toISOString(),
    }).expect(200)

    expect(res.body.data.points).toHaveLength(366)
    expect(res.body.data.truncated).toBeGreaterThan(0)
  }, 60_000)
})
