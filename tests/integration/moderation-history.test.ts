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
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'
import { machineReviewService } from '../../src/features/moderation/moderation.machine.service'

/**
 * Audit 1.13 — hai sổ cho một tranh chấp "tin tôi bị gỡ oan":
 *
 * 1. `moderationHistory` trên tin: MỌI lượt đổi trạng thái, người lẫn máy, theo thứ tự. `moderation`
 *    chỉ giữ quyết định cuối, mà tranh chấp cần cả chuỗi.
 * 2. `AuditLog` dual-axis: thao tác trên trục công khai ghi dưới `organizationId: null` thay vì bị
 *    bỏ qua; master đọc được qua `GET /moderation/activity`, quản trị nhóm KHÔNG thấy.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let categoryId = ''
let orgId = ''
const ORG = 'nhom-lich-su'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@history.local', 'Chủ nhóm')
  member = await registerUser(app, 'member@history.local', 'Thành viên')
  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm lịch sử', key: ORG, ownerEmail: owner.email })
  ).id
  await addMember(member.id, orgId)
  // Bậc 1: tin vào hàng đợi mà máy vẫn được duyệt (bậc 0 máy giữ cho người thật).
  await setTrustLevel(member.id, 1)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

async function historyOf(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const doc = await runUnscoped('test: đọc lịch sử duyệt', () =>
    Listing.findById(id).select('status moderationHistory').lean().exec(),
  )
  return doc?.moderationHistory ?? []
}

async function postAs(who: TestUser, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send(listingPayload(title, categoryId))
    .expect(201)
  return res.body.data as { _id: string; status: string }
}

describe('moderationHistory — chuỗi quyết định trên tin', () => {
  it('người duyệt từ chối rồi duyệt lại → hai dòng, đúng thứ tự, mang tên hiển thị + mức độ', async () => {
    const { _id: id } = await postAs(member, 'Bàn học gỗ thông')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ status: 'rejected', reason: 'Thiếu ảnh thật', severity: 'quality' })
      .expect(200)
    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ status: 'active' })
      .expect(200)

    const history = await historyOf(id)
    expect(history.map((h) => h.status)).toEqual(['rejected', 'active'])
    expect(history[0]).toMatchObject({
      reason: 'Thiếu ảnh thật',
      severity: 'quality',
      byName: 'Chủ nhóm',
      byUserId: new mongoose.Types.ObjectId(owner.id),
    })
    expect(history[0].machine).toBeUndefined()
    expect(history[1].severity).toBeUndefined()
  }, 60_000)

  it('máy duyệt cũng ghi một dòng, đánh dấu `machine`', async () => {
    const created = await postAs(member, 'Ghế xoay văn phòng còn mới')
    expect(created.status).toBe('pending')

    await machineReviewService.sweep()

    const history = await historyOf(created._id)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ status: 'active', machine: true, byName: 'Hệ thống' })
  }, 60_000)
})

describe('AuditLog dual-axis — trục công khai có sổ', () => {
  let publicId = ''

  beforeAll(async () => {
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const doc = await runUnscoped('test fixture: tin trục công khai', () =>
      Listing.create({
        organizationId: null,
        reach: 'marketplace',
        provinceCode: 'Hồ Chí Minh',
        wardCode: 'Phường Bến Thành',
        title: 'Tin công khai chờ duyệt',
        description: 'Mô tả đủ dài cho zod schema đi qua được',
        price: 120000,
        category: categoryId,
        seller: member.id,
        posterName: 'Thành viên',
        status: 'pending',
        location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      }),
    )
    publicId = doc._id.toString()
  })

  it('master duyệt tin công khai → dòng audit ghi dưới organizationId: null (không còn "audit skipped")', async () => {
    await request(app)
      .patch(`/api/v1/moderation/listings/${publicId}`)
      .set(bearer(master))
      .send({ status: 'active' })
      .expect(200)

    const { AuditLog } = await import('../../src/features/moderation/moderation.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const rows = await runUnscoped('test: đọc audit trục công khai', () =>
      AuditLog.find({ targetId: publicId }).lean().exec(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].organizationId).toBeNull()
    expect(rows[0].summary).toContain('Tin công khai chờ duyệt')
  }, 60_000)

  it('master đọc được dòng đó qua nhật ký; quản trị nhóm thì KHÔNG', async () => {
    const asMaster = await request(app)
      .get('/api/v1/moderation/activity')
      .set(bearer(master))
      .expect(200)
    const summaries = (asMaster.body.data as { summary: string }[]).map((r) => r.summary)
    expect(summaries.some((s) => s.includes('Tin công khai chờ duyệt'))).toBe(true)

    const asOwner = await request(app)
      .get('/api/v1/moderation/activity')
      .set(orgAuth(owner.token, ORG))
      .expect(200)
    const ownerSees = (asOwner.body.data as { summary: string }[]).map((r) => r.summary)
    expect(ownerSees.some((s) => s.includes('Tin công khai chờ duyệt'))).toBe(false)
    // Sổ của nhóm vẫn nguyên: hai lượt duyệt tin của thành viên ở describe trên.
    expect(ownerSees.some((s) => s.includes('Bàn học gỗ thông'))).toBe(true)
  }, 60_000)
})
