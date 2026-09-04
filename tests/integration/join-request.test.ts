import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createOrgUnit,
  createTestApp,
  joinCodeOf,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let orgId = ''
let unitId = ''
const SLUG = 'join-org'

const asOwner = () => orgAuth(owner.token, SLUG)

/** Mã nhóm của org test, nạp một lần trong `beforeAll` — `sendRequest` không async được. */
let code = ''

/** Không `async`: trả thẳng đối tượng của supertest để call site còn nối `.expect()` được. */
function sendRequest(user: TestUser, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/join-requests')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ code, claimedName: 'Nguyễn Văn A', ...body })
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@join-org.local', 'Owner')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Trường Join',
      slug: SLUG,
      ownerEmail: owner.email,
      orgType: 'school',
    })
  ).id
  code = await joinCodeOf(SLUG)

  unitId = await createOrgUnit(orgId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Gửi đơn tham gia', () => {
  it('người chưa thuộc org nào vẫn gửi được đơn', async () => {
    const user = await registerUser(app, 'a@example.com', 'A')
    const res = await sendRequest(user, { claimedUnit: '10A1' })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
  })

  it('gửi đơn lần hai cho cùng org bị chặn', async () => {
    const user = await registerUser(app, 'b@example.com', 'B')
    await sendRequest(user).expect(201)

    const again = await sendRequest(user)
    expect(again.status).toBe(409)
  })

  it('org tắt nhận đơn thì từ chối', async () => {
    const { Organization } = await import('../../src/features/organization/organization.model')
    const { clearOrganizationCache } =
      await import('../../src/features/organization/organization.repository')
    await Organization.updateOne({ _id: orgId }, { allowJoinRequests: false }).exec()
    clearOrganizationCache()

    const user = await registerUser(app, 'c@example.com', 'C')
    const res = await sendRequest(user)
    expect(res.status).toBe(403)

    await Organization.updateOne({ _id: orgId }, { allowJoinRequests: true }).exec()
    clearOrganizationCache()
  })

  it('người gửi xem và rút được đơn của mình', async () => {
    const user = await registerUser(app, 'd@example.com', 'D')
    const created = await sendRequest(user).expect(201)

    const mine = await request(app)
      .get('/api/v1/join-requests/mine')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
    expect(mine.body.data).toHaveLength(1)

    const cancelled = await request(app)
      .delete(`/api/v1/join-requests/${created.body.data.id}`)
      .set('Authorization', `Bearer ${user.token}`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data.status).toBe('cancelled')
  })
})

describe('Duyệt đơn', () => {
  it('người ngoài KHÔNG đọc được hàng đợi của org', async () => {
    const stranger = await registerUser(app, 'stranger@example.com', 'Người lạ')
    const res = await request(app).get('/api/v1/join-requests').set(orgAuth(stranger.token, SLUG))
    expect(res.status).toBe(403)
  })

  it('duyệt đơn thì gán nhóm con NGAY trong cùng thao tác', async () => {
    const user = await registerUser(app, 'e@example.com', 'E')
    const created = await sendRequest(user, { claimedUnit: '10A1' }).expect(201)

    const approved = await request(app)
      .patch(`/api/v1/join-requests/${created.body.data.id}/approve`)
      .set(asOwner())
      .send({ unitId })
    expect(approved.status).toBe(200)
    expect(approved.body.data.status).toBe('approved')

    const { Membership } = await import('../../src/features/membership/membership.model')
    const membership = await Membership.findOne({ userId: user.id, organizationId: orgId }).exec()
    expect(membership).not.toBeNull()
    expect(membership!.unitId?.toString()).toBe(unitId)
    expect(membership!.joinedVia).toBe('request')
  })

  it('duyệt xong thì người đó GHI được vào org (trước đó thì không)', async () => {
    const user = await registerUser(app, 'f@example.com', 'F')
    const created = await sendRequest(user).expect(201)
    const { createCategory, listingPayload } = await import('../helpers/fixtures')
    const categoryId = await createCategory('Sách', 'sach')

    // Người ngoài ĐỌC được trang công khai của org (đúng thiết kế), nhưng không ghi được:
    // scope không mở cho non-GET nên `tenantPlugin` chặn ở tầng thấp nhất.
    const readBefore = await request(app).get('/api/v1/listings').set(orgAuth(user.token, SLUG))
    expect(readBefore.status).toBe(200)

    const writeBefore = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(user.token, SLUG))
      .send(listingPayload('Tin của người chưa được duyệt', categoryId))
    expect(writeBefore.status).toBe(400)

    await request(app)
      .patch(`/api/v1/join-requests/${created.body.data.id}/approve`)
      .set(asOwner())
      .send({})
      .expect(200)

    const writeAfter = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(user.token, SLUG))
      .send(listingPayload('Tin sau khi được duyệt', categoryId))
    expect(writeAfter.status).toBe(201)
  })

  it('đơn đã xử lý thì không duyệt lại được', async () => {
    const user = await registerUser(app, 'g@example.com', 'G')
    const created = await sendRequest(user).expect(201)
    const id = created.body.data.id

    await request(app)
      .patch(`/api/v1/join-requests/${id}/approve`)
      .set(asOwner())
      .send({})
      .expect(200)

    const again = await request(app)
      .patch(`/api/v1/join-requests/${id}/approve`)
      .set(asOwner())
      .send({})
    expect(again.status).toBe(409)
  })

  it('từ chối rồi thì gửi lại bị chặn bởi cooldown', async () => {
    const user = await registerUser(app, 'h@example.com', 'H')
    const created = await sendRequest(user).expect(201)

    await request(app)
      .patch(`/api/v1/join-requests/${created.body.data.id}/reject`)
      .set(asOwner())
      .send({ reason: 'Không nhận ra người này' })
      .expect(200)

    const again = await sendRequest(user)
    expect(again.status).toBe(409)
    expect(again.body.message).toMatch(/từ chối/)
  })

  it('duyệt hàng loạt: đơn hỏng không làm hỏng cả lô', async () => {
    const u1 = await registerUser(app, 'i@example.com', 'I')
    const u2 = await registerUser(app, 'j@example.com', 'J')
    const r1 = await sendRequest(u1).expect(201)
    const r2 = await sendRequest(u2).expect(201)

    const res = await request(app)
      .post('/api/v1/join-requests/bulk-approve')
      .set(asOwner())
      .send({
        items: [
          { id: r1.body.data.id, unitId },
          { id: r2.body.data.id },
          // Đơn đã bị rút trước đó -> dòng này hỏng, hai dòng trên vẫn phải qua.
          { id: r1.body.data.id },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body.data.approved).toBe(2)
    expect(res.body.data.failed).toBe(1)
    expect(res.body.data.results[2].ok).toBe(false)
  })
})

describe('Trần số đơn đang chờ', () => {
  it('vượt trần thì bị chặn', async () => {
    const user = await registerUser(app, 'spam@example.com', 'Spam')
    const { JOIN_REQUEST_LIMITS } = await import('../../src/common/constants')

    // Dựng thêm org để rải đơn — trần đếm trên toàn hệ thống, không theo từng org.
    for (let i = 0; i < JOIN_REQUEST_LIMITS.MAX_PENDING_PER_USER; i += 1) {
      const slug = `spam-org-${i}`
      const orgOwner = await registerUser(app, `owner@${slug}.local`, 'Owner')
      await createOrg(app, master.token, {
        name: `Org ${slug}`,
        slug,
        ownerEmail: orgOwner.email,
      })
      await request(app)
        .post('/api/v1/join-requests')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ code: await joinCodeOf(slug), claimedName: 'Spam' })
        .expect(201)
    }

    const res = await sendRequest(user)
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/đơn chờ duyệt/)
  })
})
