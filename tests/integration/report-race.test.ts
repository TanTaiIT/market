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
  orgIdOf,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Hai moderator cùng bấm "gỡ" trên một báo cáo (audit 2.2).
 *
 * Trước bản sửa: `resolve` kiểm `status !== open` rồi mới ẩn tin và trừ uy tín — hai request
 * đồng thời cùng đọc được `open`, cùng qua cửa, người bán mất HAI bậc cho một báo cáo. Giờ
 * `claimOpen` (CAS trên `status: open`) đứng trước mọi side-effect: đúng một người thắng.
 *
 * Người bán đứng ở bậc 2 (trần) để phân biệt được "trừ một lần" (→ 1) với "trừ hai lần" (→ 0);
 * đứng ở bậc 1 thì cả hai đều về 0 và test không nhìn thấy gì.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let reporterA: TestUser
let reporterB: TestUser
let categoryId = ''
const ORG = 'nhom-report-race'
let seq = 0

const levelOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  return (await UserTrust.findOne({ userId }).lean().exec())?.level
}

async function newSellerAtTop() {
  seq += 1
  const u = await registerUser(app, `seller-${seq}@race.local`, `Người bán ${seq}`)
  await addMember(u.id, orgIdOf(ORG))
  await setTrustLevel(u.id, 2)
  return u
}

async function postInternal(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  expect(res.body.data.status).toBe('active')
  return res.body.data._id as string
}

async function report(who: TestUser, listingId: string) {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(orgAuth(who.token, ORG))
    .send({
      targetType: 'listing',
      targetId: listingId,
      kind: 'scam',
      quote: 'Yêu cầu chuyển khoản trước khi cho xem hàng',
    })
    .expect(201)
  return res.body.data.id as string
}

const resolveAs = (who: TestUser, reportId: string) =>
  request(app)
    .patch(`/api/v1/reports/${reportId}`)
    .set(orgAuth(who.token, ORG))
    .send({ action: 'hide_target' })

async function reportRow(id: string) {
  const { Report } = await import('../../src/features/report/report.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc báo cáo', () => Report.findById(id).lean().exec())
}

async function listingStatus(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const row = await runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status').lean().exec(),
  )
  return row?.status
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-race')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@race.local', 'Chủ nhóm')
  reporterA = await registerUser(app, 'reporter-a@race.local', 'Người tố A')
  reporterB = await registerUser(app, 'reporter-b@race.local', 'Người tố B')
  await createOrg(app, master.token, { name: 'Nhóm race', key: ORG, ownerEmail: owner.email })
  await addMember(reporterA.id, orgIdOf(ORG))
  await addMember(reporterB.id, orgIdOf(ORG))
  // Master cũng đứng trong nhóm để gửi được `X-Org-Id` như một moderator thứ hai thật sự.
  await addMember(master.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Cùng MỘT báo cáo, hai moderator bấm gỡ đồng thời', () => {
  it('đúng một người thắng (200), người kia bị chặn (400 hoặc 409), uy tín trừ ĐÚNG MỘT bậc', async () => {
    const seller = await newSellerAtTop()
    const l = await postInternal(seller)
    const r = await report(reporterA, l)

    const [a, b] = await Promise.all([resolveAs(owner, r), resolveAs(master, r)])
    const statuses = [a.status, b.status].sort()

    expect(statuses[0]).toBe(200)
    expect([400, 409]).toContain(statuses[1])

    expect(await levelOf(seller.id)).toBe(1)
    expect(await listingStatus(l)).toBe('hidden')
    const row = await reportRow(r)
    expect(row?.status).toBe('resolved')
    expect(['Chủ nhóm', 'Master']).toContain(row?.resolution?.byName)
  }, 60_000)

  it('gỡ xong rồi bấm lại (tuần tự) vẫn 400 như trước — đường cũ không đổi', async () => {
    const seller = await newSellerAtTop()
    const l = await postInternal(seller)
    const r = await report(reporterA, l)

    await resolveAs(owner, r).expect(200)
    const again = await resolveAs(master, r)

    expect(again.status).toBe(400)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)
})

describe('Hai báo cáo KHÁC NHAU về cùng một tin, xử đồng thời', () => {
  it('tin bị ẩn một lần, uy tín trừ một bậc, cả hai báo cáo đều đóng', async () => {
    const seller = await newSellerAtTop()
    const l = await postInternal(seller)
    const [rA, rB] = await Promise.all([report(reporterA, l), report(reporterB, l)])

    const [a, b] = await Promise.all([resolveAs(owner, rA), resolveAs(master, rB)])

    // Người thua CAS của tin (nếu có) nhận 409, nhưng báo cáo của họ đã được nhận xử — không
    // có báo cáo nào còn kẹt mở, và không có lượt trừ thứ hai.
    for (const res of [a, b]) expect([200, 409]).toContain(res.status)
    expect([a.status, b.status]).toContain(200)

    expect(await levelOf(seller.id)).toBe(1)
    expect(await listingStatus(l)).toBe('hidden')
    expect((await reportRow(rA))?.status).toBe('resolved')
    expect((await reportRow(rB))?.status).toBe('resolved')
  }, 60_000)
})
