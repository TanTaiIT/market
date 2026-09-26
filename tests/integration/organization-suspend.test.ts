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
  publishListing,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'
import { CASCADE_HIDE_REASON, MASTER_DISPLAY_NAME } from '../../src/common/constants'

/**
 * Tạm ngưng nhóm phải cascade xuống tin (audit 1.14): `group_open` là bậc người lạ đọc được và
 * feed của thành viên vẫn đọc `members`, nên chỉ chặn cửa vào org là chưa đủ. Mở lại thì trả
 * đúng lô tin đã ẩn về bảng — không hồi sinh tin bàn duyệt ẩn vì lý do khác.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let poster: TestUser
let stranger: TestUser
let categoryId = ''
let orgId = ''
const ORG = 'nhom-tam-ngung'
let seq = 0

let internalActive = ''
let groupOpenActive = ''
let internalPending = ''
let marketplaceActive = ''
let hiddenByModerator = ''

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

async function hideByModerator(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: bàn duyệt ẩn vì lý do khác', () =>
    Listing.updateOne(
      { _id: id },
      {
        status: 'hidden',
        moderation: { reason: 'Bị ẩn vì vi phạm', byName: 'Chủ nhóm', at: new Date() },
      },
    ).exec(),
  )
}

const setStatus = (status: string) =>
  request(app).patch(`/api/v1/organizations/${orgId}/status`).set(bearer(master)).send({ status })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-suspend')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@suspend.local', 'Chủ nhóm')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Nhóm tạm ngưng',
      key: ORG,
      ownerEmail: owner.email,
    })
  ).id
  poster = await registerUser(app, 'poster@suspend.local', 'Người đăng')
  await addMember(poster.id, orgIdOf(ORG))
  stranger = await registerUser(app, 'stranger@suspend.local', 'Người lạ')

  // Bậc 0 để tin vào hàng chờ, rồi tự chọn tin nào lên bảng bằng fixture.
  await setTrustLevel(poster.id, 0)
  internalActive = await post(poster, 'members')
  groupOpenActive = await post(poster, 'group_open')
  internalPending = await post(poster, 'members')
  await publishListing(internalActive)
  await publishListing(groupOpenActive)

  // Chủ nhóm (bậc trần): tin sàn mang badge nhóm, và một tin nội bộ bị bàn duyệt ẩn vì lý do khác.
  marketplaceActive = await post(owner, 'marketplace')
  hiddenByModerator = await post(owner, 'members')
  await hideByModerator(hiddenByModerator)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tạm ngưng nhóm', () => {
  it('trước khi ngưng: người lạ đọc được tin `group_open`', async () => {
    await request(app).get(`/api/v1/listings/${groupOpenActive}`).set(bearer(stranger)).expect(200)
  })

  it('tin trong nhóm đang hiện ẩn với lý do cố định; tin chờ và tin sàn giữ nguyên', async () => {
    await setStatus('suspended').expect(200)

    const internal = await readListing(internalActive)
    expect(internal?.status).toBe('hidden')
    expect(internal?.moderation).toMatchObject({
      reason: CASCADE_HIDE_REASON.ORG_SUSPENDED,
      byName: MASTER_DISPLAY_NAME,
    })
    expect((await readListing(groupOpenActive))?.status).toBe('hidden')
    expect((await readListing(internalPending))?.status).toBe('pending')
    expect((await readListing(marketplaceActive))?.status).toBe('active')

    await request(app).get(`/api/v1/listings/${groupOpenActive}`).set(bearer(stranger)).expect(404)
  }, 60_000)

  it('ngưng lần hai là no-op — không ghi đè lý do của tin bàn duyệt đã ẩn', async () => {
    await setStatus('suspended').expect(200)
    expect((await readListing(hiddenByModerator))?.moderation?.reason).toBe('Bị ẩn vì vi phạm')
  })
})

describe('Mở lại nhóm', () => {
  it('đúng lô đã ẩn về `active` và sạch `moderation`; tin ẩn vì lý do khác không hồi sinh', async () => {
    await setStatus('active').expect(200)

    const internal = await readListing(internalActive)
    expect(internal?.status).toBe('active')
    expect(internal?.moderation).toBeUndefined()
    expect((await readListing(groupOpenActive))?.status).toBe('active')
    expect((await readListing(internalPending))?.status).toBe('pending')
    expect((await readListing(hiddenByModerator))?.status).toBe('hidden')

    await request(app).get(`/api/v1/listings/${groupOpenActive}`).set(bearer(stranger)).expect(200)
  }, 60_000)
})
