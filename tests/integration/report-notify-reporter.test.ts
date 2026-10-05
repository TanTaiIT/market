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
  startTestDb,
} from '../helpers/fixtures'

/**
 * Audit 2.3 (vế người báo cáo): người tố là người duy nhất trong vòng xử lý không có màn nào để
 * tự xem kết quả. Gỡ hay bỏ qua đều phải báo lại một dòng — và dòng đó KHÔNG kể án uy tín của
 * người bán cho người tố.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let reporter: TestUser
let categoryId = ''
const ORG = 'nhom-bao-lai'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function postInternal() {
  seq += 1
  const seller = await registerUser(app, `seller-${seq}@notify.local`, `Người bán ${seq}`)
  await addMember(seller.id, orgIdOf(ORG))
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG))
    .send({ ...listingPayload(`Tin bị báo số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data as { _id: string; title: string }
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

async function inboxTitles() {
  const res = await request(app)
    .get('/api/v1/notifications')
    .set(orgAuth(reporter.token, ORG))
    .expect(200)
  return (res.body.data as { title: string; body: string }[]).map((n) => `${n.title} | ${n.body}`)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung-notify')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@notify.local', 'Chủ nhóm')
  reporter = await registerUser(app, 'reporter@notify.local', 'Người tố')
  await createOrg(app, master.token, { name: 'Nhóm báo lại', key: ORG, ownerEmail: owner.email })
  await addMember(reporter.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Xử báo cáo → người báo cáo được báo lại', () => {
  it('gỡ tin → "đã được xử lý", nêu tên tin, không nêu án uy tín', async () => {
    const listing = await postInternal()
    const id = await report(listing._id)

    await request(app)
      .patch(`/api/v1/reports/${id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'hide_target' })
      .expect(200)

    const lines = await inboxTitles()
    const line = lines.find((l) => l.startsWith('Báo cáo của bạn đã được xử lý'))
    expect(line).toBeDefined()
    expect(line).toContain(listing.title)
    expect(line?.toLowerCase()).not.toContain('bậc')
  }, 60_000)

  it('bỏ qua báo cáo → "đã được xem xét", tin giữ nguyên', async () => {
    const listing = await postInternal()
    const id = await report(listing._id)

    await request(app)
      .patch(`/api/v1/reports/${id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
      .expect(200)

    const lines = await inboxTitles()
    expect(
      lines.some(
        (l) => l.startsWith('Báo cáo của bạn đã được xem xét') && l.includes(listing.title),
      ),
    ).toBe(true)
  }, 60_000)

  it('master xử hộ cũng báo lại như thường', async () => {
    const listing = await postInternal()
    const id = await report(listing._id)

    await request(app)
      .patch(`/api/v1/reports/${id}`)
      .set(bearer(master))
      .send({ action: 'hide_target' })
      .expect(200)

    // Người tố cũng là thành viên nhóm nên còn nhận cả thông báo 'tin mới lên bảng' — chỉ đếm dòng báo lại.
    const lines = await inboxTitles()
    expect(
      lines.filter((l) => l.startsWith('Báo cáo của bạn') && l.includes(listing.title)),
    ).toHaveLength(1)
  }, 60_000)
})
