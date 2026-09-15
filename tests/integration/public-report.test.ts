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
  grantRole,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { Report } from '../../src/features/report/report.model'
import { runUnscoped } from '../../src/common/tenant/tenantContext'

/**
 * Báo cáo đi theo TRỤC CỦA TIN, không theo org của người tố.
 *
 * Bản trước chặn tin công khai bằng câu "sắp có", vì `Report` chỉ có một trục và sẽ đóng dấu org
 * của người tố — ba org tố cùng một tin là ba hàng đợi rời nhau mà không ai xử được. Giờ:
 *
 * - tin công khai → báo cáo `organizationId: null` + toạ độ ô → người phụ trách ô thấy và xử,
 *   master là fallback; quản trị org KHÔNG thấy;
 * - tin nội bộ → báo cáo mang org của tin → quản trị org đó xử; người phụ trách ô KHÔNG thấy;
 * - báo cáo về NGƯỠI từ người không có org → chỉ master.
 *
 * Mỗi chốt có một ca "KHÔNG thấy" đi kèm: hàng đợi báo cáo lộ ra ai tố ai, nên vế đọc mở thừa
 * một ô là một lỗi rò rỉ, không phải một tính năng rộng rãi.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let outsider: TestUser
let orgAdmin: TestUser
let member: TestUser
let hcmManager: TestUser
let hnManager: TestUser

let categoryId = ''
let orgId = ''
let publicListingId = ''
let orgListingId = ''

const SLUG = 'nhom-bao-cao-truc'
const HCM = 'Hồ Chí Minh'
const HN = 'Hà Nội'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const report = (
  headers: Record<string, string>,
  targetId: string,
  targetType: 'listing' | 'user' = 'listing',
) =>
  request(app).post('/api/v1/reports').set(headers).send({
    targetType,
    targetId,
    kind: 'scam',
    quote: 'Người bán nhận tiền rồi chặn liên lạc, không giao hàng như đã hẹn',
  })
const listIds = async (headers: Record<string, string>) => {
  const res = await request(app).get('/api/v1/reports?status=open').set(headers).expect(200)
  return (res.body.data as { id: string }[]).map((r) => r.id)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Điện tử', 'dien-tu-bc')
  master = await makeMaster(app)
  seller = await registerUser(app, 'ban@bc.local', 'Người bán')
  outsider = await registerUser(app, 'ngoai@bc.local', 'Người ngoài')
  orgAdmin = await registerUser(app, 'chu@bc.local', 'Chủ nhóm')
  member = await registerUser(app, 'thanhvien@bc.local', 'Thành viên')
  hcmManager = await registerUser(app, 'hcm@bc.local', 'Phụ trách HCM')
  hnManager = await registerUser(app, 'hn@bc.local', 'Phụ trách Hà Nội')

  const org = await createOrg(app, master.token, {
    name: 'Nhóm báo cáo',
    slug: SLUG,
    ownerEmail: orgAdmin.email,
  })
  orgId = org.id
  await addMember(member.id, orgId)

  // Hai người phụ trách cùng danh mục, hai tỉnh khác nhau — để chứng minh vế đọc theo Ô, không
  // theo danh mục trần.
  for (const [who, province] of [
    [hcmManager, HCM],
    [hnManager, HN],
  ] as const) {
    await grantRole({
      userId: who.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId,
      provinceCodes: [province],
    })
  }

  const pub = await request(app)
    .post('/api/v1/listings')
    .set(bearer(seller))
    .send({
      ...listingPayload('Tai nghe công khai', categoryId),
      visibility: 'public',
      provinceCode: HCM,
    })
    .expect(201)
  publicListingId = pub.body.data._id
  expect(pub.body.data.status).toBe('active')

  const internal = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(orgAdmin.token, SLUG))
    .send({ ...listingPayload('Loa nội bộ nhóm', categoryId), orgSlug: SLUG })
    .expect(201)
  orgListingId = internal.body.data._id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tin công khai — trục danh mục', () => {
  let reportId = ''

  it('người KHÔNG thuộc org nào báo cáo được (trước đây 400 "sắp có")', async () => {
    const res = await report(bearer(outsider), publicListingId).expect(201)
    reportId = res.body.data.id
    expect(res.body.data.targetTitle).toBe('Tai nghe công khai')

    // Đóng dấu trục của TIN: không org, kèm toạ độ ô để vế đọc lọc được ngay trên báo cáo.
    const row = await runUnscoped('test đọc báo cáo', () => Report.findById(reportId).lean().exec())
    expect(row?.organizationId).toBeNull()
    expect(row?.category?.toString()).toBe(categoryId)
    expect(row?.provinceCode).toBe(HCM)
  }, 60_000)

  it('quản trị org KHÔNG thấy nó trong hàng đợi của nhóm', async () => {
    expect(await listIds(orgAuth(orgAdmin.token, SLUG))).not.toContain(reportId)
  }, 60_000)

  it('người phụ trách ô (danh mục × HCM) thấy; người phụ trách Hà Nội thì không', async () => {
    expect(await listIds(bearer(hcmManager))).toContain(reportId)
    expect(await listIds(bearer(hnManager))).not.toContain(reportId)
  }, 60_000)

  it('master không chọn org vẫn thấy — fallback của mọi ô', async () => {
    expect(await listIds(bearer(master))).toContain(reportId)
  }, 60_000)

  it('người dùng thường không đọc, không đóng được hàng đợi', async () => {
    await request(app).get('/api/v1/reports').set(bearer(outsider)).expect(403)
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(outsider))
      .send({ action: 'ignore' })
      .expect(403)
  }, 60_000)

  it('người phụ trách Hà Nội không đóng được báo cáo của ô HCM', async () => {
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(hnManager))
      .send({ action: 'ignore' })
      .expect(403)
  }, 60_000)

  it('người phụ trách HCM gỡ tin qua báo cáo → tin ẩn, báo cáo đóng', async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(hcmManager))
      .send({ action: 'hide_target' })
      .expect(200)
    expect(res.body.data.status).toBe('resolved')

    // Tin ẩn rời khỏi trục công khai: khách không còn đọc được.
    await request(app).get(`/api/v1/listings/${publicListingId}`).expect(404)
    expect(await listIds(bearer(hcmManager))).not.toContain(reportId)
  }, 60_000)
})

describe('Tin nội bộ — trục org', () => {
  let reportId = ''

  it('báo cáo mang org của TIN; quản trị org thấy, người phụ trách ô thì không', async () => {
    const res = await report(orgAuth(member.token, SLUG), orgListingId).expect(201)
    reportId = res.body.data.id

    const row = await runUnscoped('test đọc báo cáo', () => Report.findById(reportId).lean().exec())
    expect(row?.organizationId?.toString()).toBe(orgId)
    // Toạ độ ô chỉ dành cho trục công khai — trục org không cần và không được mang.
    expect(row?.category).toBeNull()

    expect(await listIds(orgAuth(orgAdmin.token, SLUG))).toContain(reportId)
    expect(await listIds(bearer(hcmManager))).not.toContain(reportId)
  }, 60_000)

  it('master đóng được từ danh sách xuyên tổ chức, KHÔNG cần chọn org', async () => {
    expect(await listIds(bearer(master))).toContain(reportId)
    const res = await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(master))
      .send({ action: 'ignore' })
      .expect(200)
    expect(res.body.data.status).toBe('dismissed')
    // Không kẹt mở: `resolveAllForTarget` lọc org tường minh, không nhờ scope của master.
    expect(await listIds(orgAuth(orgAdmin.token, SLUG))).not.toContain(reportId)
  }, 60_000)
})

describe('Báo cáo về NGƯỜI từ người không có org', () => {
  let reportId = ''

  it('lên trục công khai: chỉ master thấy và xử', async () => {
    const res = await report(bearer(outsider), seller.id, 'user').expect(201)
    reportId = res.body.data.id

    expect(await listIds(bearer(hcmManager))).not.toContain(reportId)
    expect(await listIds(bearer(master))).toContain(reportId)

    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(hcmManager))
      .send({ action: 'ignore' })
      .expect(403)
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(bearer(master))
      .send({ action: 'ignore' })
      .expect(200)
  }, 60_000)
})

describe('GET /moderation/listings/:id — mở tin bị tố ở bất kỳ trạng thái', () => {
  it('người phụ trách ô đọc được tin đã bị ẩn; quản trị org và người thường thì không', async () => {
    // Tin công khai đã bị ẩn qua báo cáo ở trên — đường công khai không còn trả nó.
    await request(app).get(`/api/v1/listings/${publicListingId}`).expect(404)

    const res = await request(app)
      .get(`/api/v1/moderation/listings/${publicListingId}`)
      .set(bearer(hcmManager))
      .expect(200)
    expect(res.body.data.status).toBe('hidden')

    await request(app)
      .get(`/api/v1/moderation/listings/${publicListingId}`)
      .set(orgAuth(orgAdmin.token, SLUG))
      .expect(403)
    await request(app)
      .get(`/api/v1/moderation/listings/${publicListingId}`)
      .set(bearer(outsider))
      .expect(403)
  }, 60_000)

  it('master mở được tin nội bộ của org mà không cần đứng trong org', async () => {
    const res = await request(app)
      .get(`/api/v1/moderation/listings/${orgListingId}`)
      .set(bearer(master))
      .expect(200)
    expect(res.body.data.title).toBe('Loa nội bộ nhóm')
    // Người phụ trách ô công khai không có chân trong org: với họ tin này không tồn tại.
    await request(app)
      .get(`/api/v1/moderation/listings/${orgListingId}`)
      .set(bearer(hcmManager))
      .expect(404)
  }, 60_000)
})
