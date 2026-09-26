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
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * Báo cáo KHÔNG được sống lâu hơn đối tượng của nó (audit 1.7).
 *
 * Trước bản sửa: chủ tin xoá tin, bàn duyệt gỡ tin, hay master khoá tài khoản đều để nguyên báo
 * cáo `open` — người duyệt mở ra là 404 (tin đã xoá mềm), không `ignore` được, và `openReports`
 * của tổng quan đếm mãi. Giờ ba đường đó tự đóng báo cáo với `resolution.action = target_removed`,
 * và báo cáo mồ côi từ trước vẫn đóng được bằng tay.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let reporter: TestUser
let categoryId = ''
const ORG = 'nhom-report-lifecycle'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function newSeller() {
  seq += 1
  const u = await registerUser(app, `seller-${seq}@rl.local`, `Người bán ${seq}`)
  await addMember(u.id, orgIdOf(ORG))
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

async function report(listingId: string) {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(orgAuth(reporter.token, ORG))
    .send({
      targetType: 'listing',
      targetId: listingId,
      kind: 'scam',
      quote: 'Yêu cầu chuyển khoản trước khi cho xem hàng',
    })
    .expect(201)
  return res.body.data.id as string
}

async function reportRow(id: string) {
  const { Report } = await import('../../src/features/report/report.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc báo cáo', () => Report.findById(id).lean().exec())
}

async function softDeleteDirectly(listingId: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: xoá mềm thẳng, mô phỏng dữ liệu cũ', () =>
    Listing.updateOne({ _id: listingId }, { deletedAt: new Date() }).exec(),
  )
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-rl')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@rl.local', 'Chủ nhóm')
  reporter = await registerUser(app, 'reporter@rl.local', 'Người tố')
  await createOrg(app, master.token, { name: 'Nhóm RL', key: ORG, ownerEmail: owner.email })
  await addMember(reporter.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Báo cáo tự đóng khi đối tượng biến mất', () => {
  it('chủ tin xoá tin → báo cáo đang mở đóng với `target_removed`, tên người đóng là chủ tin', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)

    await request(app).delete(`/api/v1/listings/${l}`).set(bearer(seller)).expect(200)

    const row = await reportRow(r)
    expect(row?.status).toBe('resolved')
    expect(row?.resolution).toMatchObject({
      action: 'target_removed',
      byName: `Người bán ${seq - 1}`,
    })
  }, 60_000)

  it('bàn duyệt gỡ tin → báo cáo đóng, tên người gỡ trong `resolution`', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)

    await request(app)
      .delete(`/api/v1/moderation/listings/${l}`)
      .set(orgAuth(owner.token, ORG))
      .expect(200)

    const row = await reportRow(r)
    expect(row?.status).toBe('resolved')
    expect(row?.resolution).toMatchObject({ action: 'target_removed', byName: 'Chủ nhóm' })
  }, 60_000)

  it('khoá tài khoản → mọi báo cáo về tin của người đó đóng, đứng tên hệ thống', async () => {
    const seller = await newSeller()
    const l1 = await postInternal(seller)
    const l2 = await postInternal(seller)
    const [r1, r2] = [await report(l1), await report(l2)]

    await request(app)
      .patch(`/api/v1/users/${seller.id}/status`)
      .set(bearer(master))
      .send({ isActive: false, reason: 'Đăng hàng loạt tin lừa đảo' })
      .expect(200)

    for (const r of [r1, r2]) {
      const row = await reportRow(r)
      expect(row?.status).toBe('resolved')
      expect(row?.resolution?.byName).toBe('Quản trị hệ thống')
    }
  }, 60_000)

  it('báo cáo đã tự đóng thì người duyệt bấm nữa → 400 "đã xử lý"', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)
    await request(app).delete(`/api/v1/listings/${l}`).set(bearer(seller)).expect(200)

    await request(app)
      .patch(`/api/v1/reports/${r}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
      .expect(400)
  }, 60_000)

  it('hàng đợi không còn báo cáo đã đóng', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)
    await request(app).delete(`/api/v1/listings/${l}`).set(bearer(seller)).expect(200)

    const res = await request(app)
      .get('/api/v1/reports?status=open')
      .set(orgAuth(owner.token, ORG))
      .expect(200)
    expect((res.body.data as { id: string }[]).map((x) => x.id)).not.toContain(r)
  }, 60_000)
})

describe('Báo cáo mồ côi — tin đã xoá TRƯỚC khi có luật tự đóng', () => {
  it('`ignore` vẫn đóng được, không còn 404', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)
    await softDeleteDirectly(l)

    const res = await request(app)
      .patch(`/api/v1/reports/${r}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
      .expect(200)
    expect(res.body.data.status).toBe('dismissed')
  }, 60_000)

  it('`hide_target` lên tin đã xoá → chỉ đóng báo cáo, không ẩn gì, không phạt', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(l)
    await softDeleteDirectly(l)

    const res = await request(app)
      .patch(`/api/v1/reports/${r}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'hide_target' })
      .expect(200)
    expect(res.body.data.status).toBe('resolved')

    const { UserTrust } = await import('../../src/features/trust/trust.model')
    expect(await UserTrust.findOne({ userId: seller.id }).lean().exec()).toBeNull()
  }, 60_000)
})
