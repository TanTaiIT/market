import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createTestApp,
  makeMaster,
  registerUser,
  startTestDb,
  createCategory,
  listingPayload,
  orgAuth,
} from '../helpers/fixtures'

/**
 * Hai bất biến của tài khoản master, cái nào vỡ cũng không có phép kiểm nào khác bắt được:
 *
 * 1. **Đúng MỘT master.** Nó là dữ liệu mặc định do `scripts/migrate-master.ts` dựng cùng
 *    database, không phải thứ ai cấp cho ai. Chốt `§5.4` (`userService.deleteAccount`) chỉ
 *    giữ SÀN — luôn còn ≥1; ở đây là TRẦN.
 * 2. **Không ai xem được thông tin master.** Master thao tác xuyên tổ chức, nên mỗi bề mặt để
 *    lọt tên họ là một tổ chức biết được danh tính người ở cấp hệ thống.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let staff: TestUser
let outsider: TestUser
let categoryId = ''
let orgId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Xe cộ', 'xe-co')
  master = await makeMaster(app)
  staff = await registerUser(app, 'nhanvien@truong.local', 'Nhân Viên')
  outsider = await registerUser(app, 'nguoi-la@example.com', 'Người Lạ')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Trường Hùng Vương',
      slug: 'hung-vuong',
      ownerEmail: staff.email,
    })
  ).id
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const SLUG = 'hung-vuong'
const asMaster = () => ({ Authorization: `Bearer ${master.token}` })

/**
 * Người ngoài đăng tin vào org — tin vào hàng đợi chờ duyệt, đúng đầu vào của bài test.
 *
 * `orgSlug` trong BODY chứ không phải header `X-Org-Slug`: header là đường của THÀNH VIÊN
 * (org đến từ scope, đã đối chiếu membership), còn người ngoài đi đường "đề xuất vào nhóm".
 */
async function postToOrg(title: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/listings')
    .set({ Authorization: `Bearer ${outsider.token}` })
    .send({ ...listingPayload(title, categoryId), orgSlug: SLUG })
    .expect(201)
  return res.body.data._id
}

/** `audit_logs` là tenant-scoped nên đọc thẳng sẽ ném "Missing tenant context". */
async function auditOf(actorId: string): Promise<string[]> {
  const { AuditLog } = await import('../../src/features/moderation/moderation.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const rows = await runUnscoped('test đọc audit', () =>
    AuditLog.find({ actorId }).select('actorName').lean().exec(),
  )
  return rows.map((r) => r.actorName)
}

describe('Bất biến 1 — hệ thống chỉ có một master', () => {
  /**
   * Cửa nguy hiểm nhất: master là người DUY NHẤT đi qua được `POST /role-grants`, nên nếu
   * `canGrant` không cấm riêng role này thì chính họ là đường sinh ra master thứ hai.
   */
  it('master KHÔNG cấp được quyền master cho người khác', async () => {
    const res = await request(app)
      .post('/api/v1/role-grants')
      .set(asMaster())
      .send({ userId: outsider.id, role: 'master', scopeType: 'system' })

    expect(res.status).toBe(403)
  })

  it('cấp master thất bại thì KHÔNG để lại grant nào', async () => {
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const masters = await RoleGrant.countDocuments({ role: 'master', revokedAt: null }).exec()
    expect(masters).toBe(1)
  })

  /**
   * Chốt PHẢI nằm ở ROLE, không phải ở cấp bậc người cấp.
   *
   * Vế `staff` cấp được là phần bắt buộc của bài test: thiếu nó thì "master 403" ở dưới cũng
   * xanh với luật CŨ (người không phải master vốn đã bị `role !== STAFF` chặn), tức bài test
   * không chứng minh được gì về thay đổi này.
   */
  it('quản lý org cấp được staff nhưng KHÔNG cấp được master', async () => {
    const ok = await request(app)
      .post('/api/v1/role-grants')
      .set({ Authorization: `Bearer ${staff.token}` })
      .set('X-Org-Slug', SLUG)
      .send({ userId: outsider.id, role: 'staff', scopeType: 'org', orgId: orgId })
    expect(ok.status).toBe(201)

    const denied = await request(app)
      .post('/api/v1/role-grants')
      .set({ Authorization: `Bearer ${staff.token}` })
      .set('X-Org-Slug', SLUG)
      .send({ userId: outsider.id, role: 'master', scopeType: 'system' })
    expect(denied.status).toBe(403)
  })

  /** `canRevoke === canGrant`: cấm cấp cũng là cấm gỡ, nên master không tự tước quyền mình được. */
  it('master KHÔNG thu hồi được quyền master của chính mình', async () => {
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const grant = await RoleGrant.findOne({ role: 'master', revokedAt: null }).exec()

    const res = await request(app)
      .delete(`/api/v1/role-grants/${grant!._id.toString()}`)
      .set(asMaster())
    expect(res.status).toBe(403)

    const still = await RoleGrant.countDocuments({ role: 'master', revokedAt: null }).exec()
    expect(still).toBe(1)
  })

  it('không xoá được tài khoản master — cửa cuối cùng làm hệ thống mất master', async () => {
    const res = await request(app).delete('/api/v1/users/me').set(asMaster())
    expect(res.status).toBe(409)
  })
})

describe('Bất biến 2 — không ai xem được thông tin master', () => {
  /**
   * `GET /users/:id` KHÔNG đòi đăng nhập, nên đây là bề mặt lộ rộng nhất — bất kỳ ai có id.
   *
   * 404 chứ không 403: 403 xác nhận "có tài khoản ở id này", đủ để quét ra id của master.
   */
  it('hồ sơ công khai của master trả 404, không phải 403', async () => {
    const res = await request(app).get(`/api/v1/users/${master.id}`)
    expect(res.status).toBe(404)
  })

  it('người dùng thường vẫn xem được hồ sơ nhau — chốt không quét quá tay', async () => {
    const res = await request(app).get(`/api/v1/users/${staff.id}`).expect(200)
    expect(res.body.data.name).toBe('Nhân Viên')
  })

  it('chính master cũng không tự tra được qua đường công khai', async () => {
    const res = await request(app).get(`/api/v1/users/${master.id}`).set(asMaster())
    expect(res.status).toBe(404)
  })

  it('bảng người dùng của bàn quản trị không có dòng nào của master', async () => {
    const res = await request(app).get('/api/v1/users').set(asMaster()).expect(200)

    const ids = res.body.data.map((u: { id: string }) => u.id)
    expect(ids).not.toContain(master.id)
    // Người khác vẫn phải hiện ra, nếu không thì bảng rỗng cũng "pass" bài test trên.
    expect(ids).toContain(staff.id)
  })

  /**
   * Nhật ký duyệt là SNAPSHOT: tên đi thẳng vào DB lúc GHI. Che lúc đọc thì tên thật vẫn nằm
   * sẵn trong dữ liệu của từng org và rò ra ở lần đổi code sau — nên chốt nằm ở lúc ghi, và
   * test phải đi qua đúng đường ghi đó chứ không tự dựng sẵn dòng audit rồi tự soi lại.
   *
   * Phải là tin TRONG ORG: audit chỉ ghi khi có org để xếp vào (`audit skipped` với trục công
   * khai). Đó cũng đúng kịch bản nguy hiểm — master mượn `X-Org-Slug` vào duyệt hộ một trường.
   */
  it('master duyệt tin trong org → audit ghi nhãn hệ thống, không ghi tên thật', async () => {
    const id = await postToOrg('Bán xe đạp cũ')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(orgAuth(master.token, SLUG))
      .send({ status: 'active' })
      .expect(200)

    const rows = await auditOf(master.id)
    expect(rows.length).toBeGreaterThan(0)
    // Tên thật của master trong fixture là 'Master' — nó KHÔNG được có mặt ở đâu.
    expect(rows).not.toContain('Master')
    expect(rows.every((n) => n === 'Quản trị hệ thống')).toBe(true)
  })

  /** Chốt đối xứng: nhãn chỉ dán cho master, người duyệt bình thường vẫn đứng tên mình. */
  it('người duyệt thường vẫn ghi tên thật — không che quá tay', async () => {
    const id = await postToOrg('Bán bàn học cũ')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(orgAuth(staff.token, SLUG))
      .send({ status: 'active' })
      .expect(200)

    expect(await auditOf(staff.id)).toContain('Nhân Viên')
  })
})
