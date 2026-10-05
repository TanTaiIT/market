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
 * Sửa tin bị từ chối là ĐĂNG LẠI (audit 1.20): từ chối vì sai sót thì bản sửa về hàng chờ; từ
 * chối vì vi phạm thì không có cửa sửa-để-lên-lại.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let seller: TestUser
let categoryId = ''
const ORG = 'nhom-dang-lai'
let seq = 0

async function postPending() {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  expect(res.body.data.status).toBe('pending')
  return res.body.data._id as string
}

const reject = (id: string, severity: 'quality' | 'violation') =>
  request(app)
    .patch(`/api/v1/moderation/listings/${id}`)
    .set(orgAuth(owner.token, ORG))
    .send({ status: 'rejected', reason: 'Thiếu ảnh thật của món đồ', severity })

const edit = (id: string, body: object) =>
  request(app).patch(`/api/v1/listings/${id}`).set(orgAuth(seller.token, ORG)).send(body)

async function read(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status autoApproval machineReview').lean().exec(),
  )
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-resubmit')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@resubmit.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm đăng lại', key: ORG, ownerEmail: owner.email })
  seller = await registerUser(app, 'seller@resubmit.local', 'Người bán')
  await addMember(seller.id, orgIdOf(ORG))
  await setTrustLevel(seller.id, 0)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Sửa tin bị từ chối', () => {
  it('từ chối vì sai sót → sửa xong về hàng chờ, lý do `resubmitted`, máy chấm lại', async () => {
    const id = await postPending()
    await reject(id, 'quality').expect(200)
    expect((await read(id))?.status).toBe('rejected')

    await edit(id, { title: 'Đã bổ sung ảnh thật' }).expect(200)

    const doc = await read(id)
    expect(doc?.status).toBe('pending')
    expect(doc?.autoApproval?.reason).toBe('resubmitted')
    expect(doc?.machineReview).toBeNull()
  }, 60_000)

  it('từ chối vì vi phạm → sửa bị 400, tin vẫn rejected', async () => {
    const id = await postPending()
    await reject(id, 'violation').expect(200)

    const res = await edit(id, { title: 'Cố sửa cho qua' })
    expect(res.status).toBe(400)
    expect((await read(id))?.status).toBe('rejected')
  }, 60_000)
})
