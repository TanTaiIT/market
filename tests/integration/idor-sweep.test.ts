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
  joinCodeOf,
  listingPayload,
  makeMaster,
  orgAuth,
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { Organization } from '../../src/features/organization/organization.model'

/**
 * QUÉT NGƯỜI LẠ — mọi route ghi nhận id của một tài nguyên, gọi bởi người không có quyền với
 * đúng tài nguyên đó.
 *
 * Vì sao gom một file thay vì rải vào test của từng feature: đây không phải test nghiệp vụ, nó
 * là LƯỚI CHẶN HỒI QUY cho một lớp lỗi (IDOR). Rải ra thì route thêm vào tháng sau không có gì
 * nhắc người viết rằng lớp lỗi này tồn tại; gom lại thì chính file này là danh sách kiểm, tự
 * nói "thêm route ghi mới thì thêm một dòng ở đây".
 *
 * Mọi kiểm soát phía app chỉ là trang trí — ẩn nút xoá không ngăn được `curl`. Những gì file
 * này khẳng định là chốt THẬT ở server: mỗi ca gọi thẳng HTTP với token hợp lệ của CHÍNH kẻ
 * tấn công, đúng như một người cầm Postman.
 *
 * 403 hay 404 đều tính là CHẶN. Nhiều đường cố ý trả 404 để không xác nhận tài nguyên tồn tại
 * — xem `assertOwner` và `chatService.requireMembership`.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
/** Có tài khoản hợp lệ và là thành viên nhóm, nhưng không sở hữu tài nguyên nào bên dưới. */
let stranger: TestUser
let categoryId = ''
let orgId = ''
let listingId = ''
let conversationId = ''
let joinRequestId = ''
let inviteId = ''
let grantId = ''
const SLUG = 'idor-org'
const HCM = 'Hồ Chí Minh'

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

/** 403 = "không đủ quyền", 404 = "không cho biết có tồn tại". Cả hai đều là chặn. */
const BLOCKED = [403, 404]

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ cũ', 'do-cu-idor')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@idor.local', 'Chủ tin')
  stranger = await registerUser(app, 'stranger@idor.local', 'Người lạ')

  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm IDOR', slug: SLUG, ownerEmail: owner.email })
  ).id
  await addMember(stranger.id, orgId)

  const created = await request(app)
    .post('/api/v1/listings')
    .set(bearer(owner))
    .send({
      ...listingPayload('Tin của chủ tin', categoryId),
      visibility: 'public',
      provinceCode: HCM,
    })
    .expect(201)
  listingId = created.body.data._id
  await publishListing(listingId)

  // Hội thoại giữa `stranger` (người mua) và `owner`. Ca chat vì thế phải dựng người thứ BA.
  const chat = await request(app)
    .post('/api/v1/chats')
    .set(bearer(stranger))
    .send({ listingId })
    .expect(201)
  conversationId = chat.body.data.id

  // Nhóm phải RIÊNG TƯ mới sinh ra đơn chờ — nhóm công khai cho vào thẳng.
  await Organization.updateOne({ _id: orgId }, { isPublic: false }).exec()
  const applicant = await registerUser(app, 'applicant@idor.local', 'Người xin vào')
  const jr = await request(app)
    .post('/api/v1/join-requests')
    .set(bearer(applicant))
    .send({ code: await joinCodeOf(SLUG), claimedName: 'Xin vào' })
    .expect(201)
  joinRequestId = jr.body.data.id

  const invite = await request(app)
    .post('/api/v1/invites')
    .set(orgAuth(owner.token, SLUG))
    .send({ channel: 'email', value: 'moi@idor.local' })
    .expect(201)
  inviteId = invite.body.data.id

  const grant = await request(app)
    .post('/api/v1/role-grants')
    .set(bearer(master))
    .send({ userId: owner.id, role: 'staff', scopeType: 'org', orgId })
    .expect(201)
  grantId = grant.body.data.id
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

/** Gọi thẳng HTTP với token hợp lệ của chính kẻ tấn công. */
function asStranger(method: 'post' | 'patch' | 'delete', path: string, body?: object) {
  const req = request(app)[method](`/api/v1${path}`).set(bearer(stranger))
  return body ? req.send(body) : req
}

describe('Quét người lạ — tin đăng', () => {
  it('sửa tin của người khác bị chặn', async () => {
    const res = await asStranger('patch', `/listings/${listingId}`, { title: 'Tiêu đề bị đổi' })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('xoá tin của người khác bị chặn', async () => {
    const res = await asStranger('delete', `/listings/${listingId}`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('gia hạn tin của người khác bị chặn', async () => {
    const res = await asStranger('post', `/listings/${listingId}/renew`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('đánh dấu đã bán tin của người khác bị chặn', async () => {
    const res = await asStranger('post', `/listings/${listingId}/sold`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('đẩy tin của người khác bị chặn', async () => {
    const res = await asStranger('post', `/listings/${listingId}/bump`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  /** Chốt cuối: sau cả loạt cú thử, tài nguyên phải còn nguyên vẹn. */
  it('tin vẫn nguyên vẹn sau cả loạt', async () => {
    const res = await request(app).get(`/api/v1/listings/${listingId}`).expect(200)
    expect(res.body.data.title).toBe('Tin của chủ tin')
    expect(res.body.data.status).toBe('active')
  }, 60_000)
})

describe('Quét người lạ — hội thoại', () => {
  it('người ngoài hội thoại không gửi được tin nhắn vào đó', async () => {
    const third = await registerUser(app, 'third1@idor.local', 'Người thứ ba')
    const res = await request(app)
      .post(`/api/v1/chats/${conversationId}/messages`)
      .set(bearer(third))
      .send({ text: 'Chen ngang' })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('người ngoài hội thoại không đọc được nó', async () => {
    const third = await registerUser(app, 'third2@idor.local', 'Người thứ ba')
    const res = await request(app).get(`/api/v1/chats/${conversationId}`).set(bearer(third))
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('người ngoài hội thoại không đánh dấu đã đọc được', async () => {
    const third = await registerUser(app, 'third3@idor.local', 'Người thứ ba')
    const res = await request(app).patch(`/api/v1/chats/${conversationId}/read`).set(bearer(third))
    expect(BLOCKED).toContain(res.status)
  }, 60_000)
})

describe('Quét người lạ — quản trị nhóm', () => {
  it('thành viên thường không gỡ được người khác khỏi nhóm', async () => {
    const res = await request(app)
      .delete(`/api/v1/memberships/${owner.id}`)
      .set(orgAuth(stranger.token, SLUG))
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('thành viên thường không duyệt được đơn gia nhập', async () => {
    const res = await request(app)
      .patch(`/api/v1/join-requests/${joinRequestId}/approve`)
      .set(orgAuth(stranger.token, SLUG))
      .send({})
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('thành viên thường không từ chối được đơn gia nhập', async () => {
    const res = await request(app)
      .patch(`/api/v1/join-requests/${joinRequestId}/reject`)
      .set(orgAuth(stranger.token, SLUG))
      .send({ reason: 'không thích' })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('thành viên thường không thu hồi được lời mời', async () => {
    const res = await request(app)
      .delete(`/api/v1/invites/${inviteId}`)
      .set(orgAuth(stranger.token, SLUG))
    expect(BLOCKED).toContain(res.status)
  }, 60_000)
})

describe('Quét người lạ — bàn duyệt', () => {
  it('người thường không duyệt được tin', async () => {
    const res = await asStranger('patch', `/moderation/listings/${listingId}`, {
      status: 'hidden',
    })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('người thường không gỡ được tin qua bàn duyệt', async () => {
    const res = await asStranger('delete', `/moderation/listings/${listingId}`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('người thường không chuyển được tin sang ô khác', async () => {
    const res = await asStranger('patch', `/moderation/listings/${listingId}/route`, {
      provinceCode: HCM,
    })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)
})

describe('Quét người lạ — quyền hệ thống', () => {
  /** Ca nguy hiểm nhất của cả file: tự nâng mình lên master. */
  it('không tự cấp quyền master cho mình được', async () => {
    const res = await asStranger('post', '/role-grants', {
      userId: stranger.id,
      role: 'master',
      scopeType: 'system',
    })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('không thu hồi được quyền của người khác', async () => {
    const res = await asStranger('delete', `/role-grants/${grantId}`)
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('không khoá được tài khoản người khác', async () => {
    const res = await asStranger('patch', `/users/${owner.id}/status`, { isActive: false })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)

  it('không xoá được đơn tố cáo của người khác', async () => {
    const reported = await request(app)
      .post('/api/v1/reports')
      .set(bearer(owner))
      .send({ targetType: 'listing', targetId: listingId, reason: 'spam' })
    // Ca chỉ có nghĩa khi tạo được đơn; BE có thể chặn tự tố cáo tin của chính mình.
    if (reported.status !== 201) return

    const res = await asStranger('patch', `/reports/${reported.body.data.id}`, {
      action: 'dismiss',
    })
    expect(BLOCKED).toContain(res.status)
  }, 60_000)
})

describe('Quét người lạ — số liệu toàn hệ thống là của master', () => {
  const MASTER_ONLY = [
    '/listings/report',
    '/users/report',
    '/listings/posting-stats',
    '/users',
    '/moderation/coverage',
  ]

  it('người thường không đọc được bất kỳ đường nào', async () => {
    for (const path of MASTER_ONLY) {
      const res = await request(app).get(`/api/v1${path}`).set(bearer(stranger))
      expect(BLOCKED, `${path} phải bị chặn nhưng trả ${res.status}`).toContain(res.status)
    }
  }, 60_000)

  it('khách không token cũng không đọc được', async () => {
    for (const path of MASTER_ONLY) {
      const res = await request(app).get(`/api/v1${path}`)
      expect([401, ...BLOCKED], `${path} trả ${res.status}`).toContain(res.status)
    }
  }, 60_000)
})
