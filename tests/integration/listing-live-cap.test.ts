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
import { TRUST_LIVE_LIMITS, TRUST_PENDING_LIMITS } from '../../src/features/listing/listing.quota'

/**
 * Trần tin ĐANG SỐNG theo bậc uy tín (audit 1.3). Người bán ở bậc 0 để con số nhỏ: trần 10 tin
 * sống, quota chờ 3 — mỗi vòng đăng 3 rồi đưa lên bảng bằng fixture, đúng như người duyệt làm.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let seller: TestUser
let categoryId = ''
const ORG = 'nhom-tran-tin'
let seq = 0

const LIVE_LIMIT = TRUST_LIVE_LIMITS[0]
const PENDING_LIMIT = TRUST_PENDING_LIMITS[0]

const post = () => {
  seq += 1
  return request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG))
    .send({ ...listingPayload(`Tin số ${seq}`, categoryId), reach: 'members' })
}
const quota = () => request(app).get('/api/v1/listings/quota').set(orgAuth(seller.token, ORG))

async function forceStatus(id: string, status: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test: ép trạng thái', () => Listing.updateOne({ _id: id }, { status }).exec())
}

const active: string[] = []

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-live-cap')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@livecap.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm trần tin', key: ORG, ownerEmail: owner.email })
  seller = await registerUser(app, 'seller@livecap.local', 'Người bán bậc 0')
  await addMember(seller.id, orgIdOf(ORG))
  await setTrustLevel(seller.id, 0)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Trần tin đang sống', () => {
  it(`đủ ${LIVE_LIMIT} tin sống thì tin kế bị chặn 409 kèm con số, và màn quota nói \`live_full\``, async () => {
    // 3 vòng × 3 tin chờ → đưa lên bảng = 9 tin hiện; thêm 1 tin chờ = 10 tin sống.
    for (let round = 0; round < 3; round += 1) {
      const ids: string[] = []
      for (let i = 0; i < PENDING_LIMIT; i += 1) {
        const res = await post().expect(201)
        expect(res.body.data.status).toBe('pending')
        ids.push(res.body.data._id)
      }
      for (const id of ids) await publishListing(id)
      active.push(...ids)
    }
    await post().expect(201)

    const q = await quota().expect(200)
    expect(q.body.data.live).toEqual({ count: LIVE_LIMIT, limit: LIVE_LIMIT })
    expect(q.body.data.allowed).toBe(false)
    expect(q.body.data.reason).toBe('live_full')

    const blocked = await post()
    expect(blocked.status).toBe(409)
    expect(blocked.body.message).toContain(`${LIVE_LIMIT}/${LIVE_LIMIT}`)
  }, 120_000)

  it('đánh dấu đã bán một tin là đăng lại được ngay', async () => {
    const sold = active.pop()!
    await request(app)
      .post(`/api/v1/listings/${sold}/sold`)
      .set(orgAuth(seller.token, ORG))
      .expect(200)

    const q = await quota().expect(200)
    expect(q.body.data.live.count).toBe(LIVE_LIMIT - 1)

    await post().expect(201)
  }, 60_000)

  it('gia hạn tin ĐÃ HẾT HẠN cũng đội trần: đầy thì 409, có chỗ thì 200', async () => {
    // Đang 10 tin sống. Một tin hết hạn → còn 9 → đăng thêm 1 → lại 10 → gia hạn tin hết hạn → 409.
    const expired = active.pop()!
    await forceStatus(expired, 'expired')
    await post().expect(201)

    const full = await request(app)
      .post(`/api/v1/listings/${expired}/renew`)
      .set(orgAuth(seller.token, ORG))
    expect(full.status).toBe(409)
    expect(full.body.message).toContain('gia hạn')

    // Bán một tin là có chỗ → gia hạn được.
    const sold = active.pop()!
    await request(app)
      .post(`/api/v1/listings/${sold}/sold`)
      .set(orgAuth(seller.token, ORG))
      .expect(200)
    const ok = await request(app)
      .post(`/api/v1/listings/${expired}/renew`)
      .set(orgAuth(seller.token, ORG))
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('active')
  }, 60_000)

  it('trần đi theo bậc: lên bậc 2 là trần 100, cùng số tin đó đăng tiếp được', async () => {
    await setTrustLevel(seller.id, 2)
    const q = await quota().expect(200)
    expect(q.body.data.live.limit).toBe(TRUST_LIVE_LIMITS[2])
    expect(q.body.data.allowed).toBe(true)
  }, 60_000)
})
