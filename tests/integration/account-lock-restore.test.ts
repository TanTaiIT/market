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
import { CASCADE_HIDE_KIND } from '../../src/common/constants'

/**
 * Mở khoá trả tin về đúng trạng thái trước khi khoá (audit 1.9). Khoá chụp `restoreTo` cho từng
 * tin trong cùng một lượt ghi: tin hiện về hiện, tin chờ về chờ; tin bàn duyệt ẩn vì lý do khác
 * không hồi sinh theo.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let seller: TestUser
let categoryId = ''
const ORG = 'nhom-mo-khoa'
let seq = 0

let wasActive = ''
let wasPending = ''
let hiddenBefore = ''

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function post(who: TestUser) {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
    .expect(201)
  return res.body.data._id as string
}

async function force(id: string, patch: Record<string, unknown>) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: ép trạng thái', () => Listing.updateOne({ _id: id }, patch).exec())
}

async function read(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đọc tin', () =>
    Listing.findById(id).select('status moderation').lean().exec(),
  )
}

const setStatus = (isActive: boolean, reason?: string) =>
  request(app)
    .patch(`/api/v1/users/${seller.id}/status`)
    .set(bearer(master))
    .send(reason ? { isActive, reason } : { isActive })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-unlock')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@unlock.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm mở khoá', key: ORG, ownerEmail: owner.email })
  seller = await registerUser(app, 'seller@unlock.local', 'Người bán')
  await addMember(seller.id, orgIdOf(ORG))

  wasActive = await post(seller)
  wasPending = await post(seller)
  await force(wasPending, { status: 'pending' })
  hiddenBefore = await post(seller)
  await force(hiddenBefore, {
    status: 'hidden',
    moderation: { reason: 'Vi phạm nội quy nhóm', byName: 'Chủ nhóm', at: new Date() },
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Khoá rồi mở khoá', () => {
  it('khoá: tin hiện lẫn tin chờ đều ẩn, kèm dấu cascade và trạng thái cũ', async () => {
    await setStatus(false, 'Đăng hàng loạt tin trùng lặp').expect(200)

    const active = await read(wasActive)
    expect(active?.status).toBe('hidden')
    expect(active?.moderation).toMatchObject({
      cascade: CASCADE_HIDE_KIND.ACCOUNT_LOCKED,
      restoreTo: 'active',
    })
    expect((await read(wasPending))?.moderation).toMatchObject({ restoreTo: 'pending' })
    // Tin bàn duyệt ẩn từ trước không bị ghi đè lý do.
    expect((await read(hiddenBefore))?.moderation?.reason).toBe('Vi phạm nội quy nhóm')
  }, 60_000)

  it('mở khoá: tin hiện về hiện, tin chờ về chờ, tin ẩn vì lý do khác vẫn ẩn', async () => {
    await setStatus(true).expect(200)

    const active = await read(wasActive)
    expect(active?.status).toBe('active')
    expect(active?.moderation).toBeUndefined()
    expect((await read(wasPending))?.status).toBe('pending')
    expect((await read(hiddenBefore))?.status).toBe('hidden')
  }, 60_000)
})
