import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  PASSWORD,
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  orgIdOf,
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { CASCADE_HIDE_REASON } from '../../src/common/constants'

/**
 * `POST /memberships/leave` (audit 3.13) và cascade tin khi không còn trong nhóm (audit 1.14):
 * rời hay bị gỡ đều ẩn tin TRONG NHÓM của người đó và đóng báo cáo về chúng; tin lên sàn giữ
 * nguyên. Quản trị duy nhất không rời được — nhóm không được rơi vào không người phụ trách.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let reporter: TestUser
let categoryId = ''
let orgId = ''
const ORG = 'nhom-roi'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function post(who: TestUser, reach: string) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach })
    .expect(201)
  return res.body.data._id as string
}

async function readListing(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status moderation').lean().exec(),
  )
}

async function reportRow(id: string) {
  const { Report } = await import('../../src/features/report/report.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc báo cáo', () => Report.findById(id).lean().exec())
}

async function membershipStatus(userId: string) {
  const { Membership } = await import('../../src/features/membership/membership.model')
  const row = await Membership.findOne({ userId, organizationId: orgId }).lean().exec()
  return row?.status
}

const leave = (who: TestUser) =>
  request(app).post('/api/v1/memberships/leave').set(orgAuth(who.token, ORG))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-leave')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@leave.local', 'Chủ nhóm')
  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm rời', key: ORG, ownerEmail: owner.email })
  ).id
  member = await registerUser(app, 'member@leave.local', 'Thành viên rời')
  await addMember(member.id, orgIdOf(ORG))
  reporter = await registerUser(app, 'reporter@leave.local', 'Người tố')
  await addMember(reporter.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Thành viên rời nhóm', () => {
  it('membership lưu trữ, tin trong nhóm ẩn kèm lý do, báo cáo về chúng đóng, tin sàn giữ nguyên', async () => {
    const internal = await post(member, 'members')
    const open = await post(member, 'group_open')
    const marketplace = await post(member, 'marketplace')
    await publishListing(marketplace)
    const report = await request(app)
      .post('/api/v1/reports')
      .set(orgAuth(reporter.token, ORG))
      .send({
        targetType: 'listing',
        targetId: internal,
        kind: 'scam',
        quote: 'Yêu cầu chuyển khoản trước khi cho xem hàng',
      })
      .expect(201)

    await leave(member).expect(200)

    expect(await membershipStatus(member.id)).toBe('archived')
    const hidden = await readListing(internal)
    expect(hidden?.status).toBe('hidden')
    expect(hidden?.moderation).toMatchObject({
      reason: CASCADE_HIDE_REASON.LEFT_ORG,
      byName: 'Thành viên rời',
    })
    expect((await readListing(open))?.status).toBe('hidden')
    expect((await readListing(marketplace))?.status).toBe('active')
    expect((await reportRow(report.body.data.id))?.status).toBe('resolved')

    // Không còn là thành viên: danh bạ đóng cửa, rời lần hai cũng không qua được cổng.
    await request(app).get('/api/v1/memberships').set(orgAuth(member.token, ORG)).expect(403)
    await leave(member).expect(403)
  }, 60_000)

  it('người chưa từng vào nhóm gọi rời → 403', async () => {
    const stranger = await registerUser(app, 'stranger@leave.local', 'Người lạ')
    await leave(stranger).expect(403)
  })
})

describe('Quản trị duy nhất', () => {
  it('không rời được (409); trao quyền cho người khác xong thì rời được', async () => {
    const res = await leave(owner)
    expect(res.status).toBe(409)
    expect(await membershipStatus(owner.id)).toBe('active')

    const next = await registerUser(app, 'next-admin@leave.local', 'Quản trị kế')
    await addMember(next.id, orgIdOf(ORG))
    await request(app)
      .post(`/api/v1/organizations/${orgId}/admin`)
      .set(bearer(master))
      .send({ email: next.email })
      .expect(200)

    await leave(owner).expect(200)
    expect(await membershipStatus(owner.id)).toBe('archived')
  }, 60_000)
})

describe('Bị quản trị gỡ khỏi nhóm', () => {
  it('tin trong nhóm của người bị gỡ cũng ẩn, ghi tên quản trị đã gỡ', async () => {
    const kicked = await registerUser(app, 'kicked@leave.local', 'Người bị gỡ')
    await addMember(kicked.id, orgIdOf(ORG))
    const internal = await post(kicked, 'members')
    expect((await readListing(internal))?.status).toBe('active')

    const admin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'next-admin@leave.local', password: PASSWORD })
      .expect(200)
    const token = admin.body.data.tokens.accessToken as string
    await request(app)
      .delete(`/api/v1/memberships/${kicked.id}`)
      .set(orgAuth(token, ORG))
      .expect(200)

    const hidden = await readListing(internal)
    expect(hidden?.status).toBe('hidden')
    expect(hidden?.moderation).toMatchObject({
      reason: CASCADE_HIDE_REASON.REMOVED_FROM_ORG,
      byName: 'Quản trị kế',
    })
  }, 60_000)
})
