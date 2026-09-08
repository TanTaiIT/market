import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { Organization } from '../../src/features/organization/organization.model'
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
  /*
   * Org của file này là RIÊNG TƯ có chủ ý: nhóm công khai nay cho vào NGAY (không sinh đơn
   * chờ), nên toàn bộ luồng duyệt/từ chối/cooldown dưới đây chỉ còn quan sát được ở nhóm kín.
   * Nhánh vào-ngay của nhóm công khai có describe riêng ở cuối file.
   */
  await Organization.updateOne({ _id: orgId }, { isPublic: false }).exec()

  code = await joinCodeOf(SLUG)

  unitId = await createOrgUnit(orgId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

async function isMemberOf(userId: string, organizationId: string) {
  const { Membership } = await import('../../src/features/membership/membership.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đếm membership', () =>
    Membership.countDocuments({ userId, organizationId, status: 'active' }).exec(),
  )
}

async function requestsOf(userId: string, organizationId: string) {
  const { JoinRequest } = await import('../../src/features/join-request/join-request.model')
  return JoinRequest.find({ userId, organizationId }).lean().exec()
}

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

    /*
     * Dựng thêm org để rải đơn — trần đếm trên toàn hệ thống, không theo từng org.
     *
     * Các org này phải RIÊNG TƯ: nhóm công khai cho vào ngay nên không sinh đơn chờ nào, và
     * vòng lặp sẽ chỉ tạo ra một loạt membership rồi trần không bao giờ chạm tới.
     */
    for (let i = 0; i < JOIN_REQUEST_LIMITS.MAX_PENDING_PER_USER; i += 1) {
      const slug = `spam-org-${i}`
      const orgOwner = await registerUser(app, `owner@${slug}.local`, 'Owner')
      const spamOrg = await createOrg(app, master.token, {
        name: `Org ${slug}`,
        slug,
        ownerEmail: orgOwner.email,
      })
      await Organization.updateOne({ _id: spamOrg.id }, { isPublic: false }).exec()
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

/**
 * Nhóm CÔNG KHAI: bấm là vào, không có bước duyệt. Nhóm riêng tư mới phải duyệt — toàn bộ
 * phần trên của file này chạy trên đúng org đó sau khi `beforeAll` hạ nó xuống riêng tư.
 */
describe('Nhóm công khai — vào ngay', () => {
  const PUBLIC_SLUG = 'join-open'
  let publicOrgId = ''

  beforeAll(async () => {
    publicOrgId = (
      await createOrg(app, master.token, {
        name: 'Nhóm Mở',
        slug: PUBLIC_SLUG,
        ownerEmail: owner.email,
      })
    ).id
  }, 60_000)

  const joinPublic = (user: TestUser, body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/join-requests')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ slug: PUBLIC_SLUG, claimedName: 'Người vào ngay', ...body })

  it('bấm gia nhập là thành viên ngay, đơn ghi lại ở trạng thái approved', async () => {
    const user = await registerUser(app, 'open1@example.com', 'Mở 1')
    const res = await joinPublic(user).expect(201)

    expect(res.body.data.status).toBe('approved')
    expect(await isMemberOf(user.id, publicOrgId)).toBe(1)

    // Vẫn phải có vết: đây là chỗ duy nhất trả lời "ai vào nhóm lúc nào, bằng đường nào".
    const docs = await requestsOf(user.id, publicOrgId)
    expect(docs).toHaveLength(1)
    // `reviewedBy` null vì KHÔNG có ai duyệt — không được ghi chính người xin vào vào đó.
    expect(docs[0]!.reviewedBy).toBeNull()
    expect(docs[0]!.reviewedAt).not.toBeNull()
  }, 60_000)

  it('vào rồi thì bấm lại bị chặn như cũ', async () => {
    const user = await registerUser(app, 'open2@example.com', 'Mở 2')
    await joinPublic(user).expect(201)
    await joinPublic(user).expect(409)
  }, 60_000)

  /** `allowJoinRequests` là công tắc RIÊNG: nhóm công khai vẫn đóng được cửa nhận người. */
  it('nhóm công khai nhưng đã tắt nhận đơn thì không vào được', async () => {
    await Organization.updateOne({ _id: publicOrgId }, { allowJoinRequests: false }).exec()
    const user = await registerUser(app, 'open3@example.com', 'Mở 3')

    await joinPublic(user).expect(403)
    expect(await isMemberOf(user.id, publicOrgId)).toBe(0)

    await Organization.updateOne({ _id: publicOrgId }, { allowJoinRequests: true }).exec()
  }, 60_000)

  /**
   * Trần đơn chờ bảo vệ hàng đợi của người duyệt. Nhóm công khai không có hàng đợi nào, nên
   * chốt đó không được biến thành lời từ chối vô cớ ở đây.
   */
  it('trần số đơn đang chờ không chặn nhóm công khai', async () => {
    const user = await registerUser(app, 'open4@example.com', 'Mở 4')

    // Rải đủ đơn chờ vào các nhóm RIÊNG TƯ cho tới đúng trần.
    const { JOIN_REQUEST_LIMITS } = await import('../../src/common/constants')
    for (let i = 0; i < JOIN_REQUEST_LIMITS.MAX_PENDING_PER_USER; i += 1) {
      const slug = `join-priv-${i}`
      const org = await createOrg(app, master.token, {
        name: `Kín ${i}`,
        slug,
        ownerEmail: owner.email,
      })
      await Organization.updateOne({ _id: org.id }, { isPublic: false }).exec()
      await request(app)
        .post('/api/v1/join-requests')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ code: await joinCodeOf(slug), claimedName: 'Rải đơn' })
        .expect(201)
    }

    await joinPublic(user).expect(201)
    expect(await isMemberOf(user.id, publicOrgId)).toBe(1)
  }, 120_000)

  /**
   * Nhóm đang kín, người ta xin vào, rồi nhóm mở cửa. Bấm lại phải DUYỆT chính đơn cũ — sinh
   * đơn thứ hai là để lại một đơn treo trong hàng đợi cho người đã là thành viên.
   */
  it('đơn cũ từ lúc còn kín được duyệt lại, không sinh đơn thứ hai', async () => {
    const org = await createOrg(app, master.token, {
      name: 'Kín rồi mở',
      slug: 'join-flip',
      ownerEmail: owner.email,
    })
    await Organization.updateOne({ _id: org.id }, { isPublic: false }).exec()

    const user = await registerUser(app, 'open5@example.com', 'Mở 5')
    const first = await request(app)
      .post('/api/v1/join-requests')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ code: await joinCodeOf('join-flip'), claimedName: 'Chờ đã' })
      .expect(201)
    expect(first.body.data.status).toBe('pending')

    await Organization.updateOne({ _id: org.id }, { isPublic: true }).exec()

    const second = await request(app)
      .post('/api/v1/join-requests')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ slug: 'join-flip', claimedName: 'Vào luôn' })
      .expect(201)

    expect(second.body.data.status).toBe('approved')
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(await requestsOf(user.id, org.id)).toHaveLength(1)
    expect(await isMemberOf(user.id, org.id)).toBe(1)
  }, 120_000)
})
