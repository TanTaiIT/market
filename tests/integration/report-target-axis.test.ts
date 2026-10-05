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
 * Audit 2.5: không tự báo cáo tin của mình; báo cáo về NGƯỜI chỉ vào hàng đợi của nhóm khi người
 * bị tố cũng ở trong nhóm đó — người lạ với nhóm thì lên trục công khai, master xử.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let reporter: TestUser
let outsider: TestUser
let categoryId = ''
const ORG = 'nhom-truc-bao-cao'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const QUOTE = 'Yêu cầu chuyển khoản trước khi cho xem hàng'

const reportUser = (targetId: string) =>
  request(app)
    .post('/api/v1/reports')
    .set(orgAuth(reporter.token, ORG))
    .send({ targetType: 'user', targetId, kind: 'harassment', quote: QUOTE })

const openIds = async (headers: Record<string, string>) => {
  const res = await request(app).get('/api/v1/reports?status=open').set(headers).expect(200)
  return (res.body.data as { id: string }[]).map((r) => r.id)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-axis')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@axis.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm trục', key: ORG, ownerEmail: owner.email })
  member = await registerUser(app, 'member@axis.local', 'Thành viên')
  reporter = await registerUser(app, 'reporter@axis.local', 'Người tố')
  outsider = await registerUser(app, 'outsider@axis.local', 'Người ngoài')
  await addMember(member.id, orgIdOf(ORG))
  await addMember(reporter.id, orgIdOf(ORG))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tự báo cáo', () => {
  it('tin của chính mình → 400', async () => {
    const posted = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(owner.token, ORG))
      .send({ ...listingPayload('Tin của chủ nhóm', categoryId), reach: 'members' })
      .expect(201)
    const res = await request(app)
      .post('/api/v1/reports')
      .set(orgAuth(owner.token, ORG))
      .send({ targetType: 'listing', targetId: posted.body.data._id, kind: 'scam', quote: QUOTE })
    expect(res.status).toBe(400)
  })
})

describe('Báo cáo về NGƯỜI — trục theo quan hệ với nhóm', () => {
  it('người bị tố cùng nhóm → nhóm thấy và xử được', async () => {
    const res = await reportUser(member.id).expect(201)
    expect(await openIds(orgAuth(owner.token, ORG))).toContain(res.body.data.id)

    await request(app)
      .patch(`/api/v1/reports/${res.body.data.id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
      .expect(200)
  }, 60_000)

  it('người bị tố KHÔNG ở trong nhóm → nhóm không thấy, quản trị nhóm không xử được, master xử', async () => {
    const res = await reportUser(outsider.id).expect(201)
    const id = res.body.data.id as string

    expect(await openIds(orgAuth(owner.token, ORG))).not.toContain(id)
    expect(await openIds(bearer(master))).toContain(id)

    const denied = await request(app)
      .patch(`/api/v1/reports/${id}`)
      .set(orgAuth(owner.token, ORG))
      .send({ action: 'ignore' })
    expect([403, 404]).toContain(denied.status)

    await request(app)
      .patch(`/api/v1/reports/${id}`)
      .set(bearer(master))
      .send({ action: 'ignore' })
      .expect(200)
  }, 60_000)
})
