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
 * Hàng đợi báo cáo hiện tên người tố — nhưng quản trị nhóm cũng là người bán trong nhóm đó
 * (audit 2.4): dòng nào tố TIN CỦA HỌ thì họ không được biết ai tố. Các dòng khác vẫn có tên.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let reporter: TestUser
let categoryId = ''
const ORG = 'nhom-an-danh'
let seq = 0

async function postInternal(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data._id as string
}

async function report(targetId: string, targetType = 'listing') {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(orgAuth(reporter.token, ORG))
    .send({
      targetType,
      targetId,
      kind: 'scam',
      quote: 'Yêu cầu chuyển khoản trước khi cho xem hàng',
    })
    .expect(201)
  return res.body.data.id as string
}

const listAs = (who: TestUser) =>
  request(app).get('/api/v1/reports?status=open').set(orgAuth(who.token, ORG))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-anon')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@anon.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm ẩn danh', key: ORG, ownerEmail: owner.email })
  member = await registerUser(app, 'member@anon.local', 'Thành viên')
  reporter = await registerUser(app, 'reporter@anon.local', 'Người tố')
  await addMember(member.id, orgIdOf(ORG))
  await addMember(reporter.id, orgIdOf(ORG))
  await addMember(master.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tên người tố che với chính chủ', () => {
  let ownListingReport = ''
  let otherListingReport = ''

  beforeAll(async () => {
    ownListingReport = await report(await postInternal(owner))
    otherListingReport = await report(await postInternal(member))
  })

  it('chủ nhóm thấy tên người tố ở tin của NGƯỜI KHÁC, nhưng không ở tin của mình', async () => {
    const res = await listAs(owner).expect(200)
    const rows = res.body.data as { id: string; reporterName: string }[]

    expect(rows.find((r) => r.id === otherListingReport)?.reporterName).toBe('Người tố')
    expect(rows.find((r) => r.id === ownListingReport)?.reporterName).toBe('Người dùng ẩn danh')
  })

  it('master (không phải chủ tin) thấy tên thật ở cả hai dòng', async () => {
    const res = await listAs(master).expect(200)
    const rows = res.body.data as { id: string; reporterName: string }[]

    expect(rows.find((r) => r.id === ownListingReport)?.reporterName).toBe('Người tố')
    expect(rows.find((r) => r.id === otherListingReport)?.reporterName).toBe('Người tố')
  })

  it('báo cáo về NGƯỜI: chính người bị tố (có quyền duyệt) cũng không thấy tên', async () => {
    const id = await report(owner.id, 'user')
    const res = await listAs(owner).expect(200)
    const row = (res.body.data as { id: string; reporterName: string }[]).find((r) => r.id === id)
    expect(row?.reporterName).toBe('Người dùng ẩn danh')
  })

  it('kết quả xử báo cáo của chính mình cũng che tên', async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/${ownListingReport}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
      .expect(200)
    expect(res.body.data.reporterName).toBe('Người dùng ẩn danh')
  })
})
