import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createOrg,
  createTestApp,
  grantRole,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * `GET /metrics/system` — bàn tổng quan của master.
 *
 * Hai thứ được canh ở đây, và thứ hai mới là thứ khó:
 *
 * 1. **Cách ly.** Số liệu gộp mọi tổ chức, nên chỉ master đọc được — admin org và manager danh
 *    mục đều phải 403, kể cả khi họ là quản trị hợp lệ ở bàn của mình.
 * 2. **Không bị trục tenant cắt.** `requireMaster` KHÔNG mở tenant scope, và master không chọn
 *    tổ chức nên `resolveTenant` đặt `publicOnlyScope()`. Thiếu `runUnscoped` trong
 *    `metrics.repository` thì endpoint vẫn trả 200 với hình dạng đúng — chỉ có các con số nhỏ
 *    hơn thực tế. Không exception, không log. Vì vậy phải có test so số thật, chứ một test
 *    "200 OK" sẽ xanh trên đúng cái bug này.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Manager của org A — quản trị hợp lệ ở bàn của mình, nhưng không được đọc bàn hệ thống. */
let ownerA: TestUser
/** Manager trục danh mục — cũng là quản trị hợp lệ, cũng không được đọc bàn hệ thống. */
let catManager: TestUser
let categoryId = ''

const SLUG_A = 'nhom-metrics-a'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner-a@metrics.local', 'Chủ nhóm A')
  catManager = await registerUser(app, 'cat@metrics.local', 'Quản danh mục')

  await createOrg(app, master.token, { name: 'Nhóm A', slug: SLUG_A, ownerEmail: ownerA.email })

  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId,
    provinceCodes: ['Hồ Chí Minh'],
  })

  /*
   * Hai tin, mỗi trục một tin — đây là mồi của ca số 2.
   *
   * Tin `org_internal` nằm NGOÀI predicate của `publicOnlyScope` (nó chỉ phủ tin công khai đã
   * duyệt), nên nếu repository thiếu `runUnscoped` thì `listings.total` sẽ đếm thiếu đúng tin
   * này. Tin công khai của tài khoản mới thì tự lên `active` (bậc uy tín trần), nên nó KHÔNG
   * đóng vai chứng cứ ở đây — chỉ tin nội bộ mới phân biệt được hai trường hợp.
   */
  await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(ownerA.token, SLUG_A))
    .send({ ...listingPayload('Tin nội bộ của nhóm A', categoryId), orgSlug: SLUG_A })
    .expect(201)

  await request(app)
    .post('/api/v1/listings')
    .set({ Authorization: `Bearer ${ownerA.token}` })
    .send({
      ...listingPayload('Tin công khai', categoryId),
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function get(token?: string) {
  const req = request(app).get('/api/v1/metrics/system')
  return token ? req.set({ Authorization: `Bearer ${token}` }) : req
}

describe('Cách ly bàn tổng quan hệ thống', () => {
  it('master đọc được', async () => {
    const res = await get(master.token).expect(200)
    expect(res.body.data.generatedAt).toBeTypeOf('string')
  }, 60_000)

  it('admin org KHÔNG đọc được, kể cả khi gửi kèm org của mình', async () => {
    await get(ownerA.token).expect(403)
    await request(app).get('/api/v1/metrics/system').set(orgAuth(ownerA.token, SLUG_A)).expect(403)
  }, 60_000)

  it('manager trục danh mục KHÔNG đọc được', async () => {
    // Người này mở được `/moderation/public-overview`; bàn hệ thống là một cửa khác hẳn.
    await get(catManager.token).expect(403)
  }, 60_000)

  it('khách chưa đăng nhập nhận 401, không phải 403', async () => {
    await get().expect(401)
  }, 60_000)
})

describe('Số liệu KHÔNG bị trục tenant cắt', () => {
  it('đếm cả tin nội bộ của nhóm mà master không thuộc về', async () => {
    const { listings } = (await get(master.token).expect(200)).body.data

    // Hai tin đã tạo ở `beforeAll`, mỗi trục một tin. Thiếu `runUnscoped` thì `orgInternal` = 0
    // và `total` = 1 — đúng hình dạng, sai số liệu.
    expect(listings.orgInternal).toBe(1)
    expect(listings.publicAxis).toBe(1)
    expect(listings.total).toBe(2)
  }, 60_000)

  it('đếm được tổ chức và người dùng của cả hệ thống', async () => {
    const { organizations, users } = (await get(master.token).expect(200)).body.data

    expect(organizations.total).toBe(1)
    expect(organizations.active).toBe(1)
    // master + ownerA + catManager. Master cũng là một tài khoản thật trong bảng `users`.
    expect(users.total).toBe(3)
    expect(users.locked).toBe(0)
  }, 60_000)

  it('khối phát hiện tồn đọng có mặt và đọc được ma trận phủ sóng', async () => {
    const { moderation } = (await get(master.token).expect(200)).body.data

    // Một danh mục × 34 tỉnh. `totalCells` = 0 nghĩa là `coverage()` không chạy được.
    expect(moderation.totalCells).toBeGreaterThan(0)
    // Chỉ HCM có người phụ trách, nên mọi tỉnh còn lại là ô trắng.
    expect(moderation.uncoveredCells).toBeGreaterThan(0)
    expect(moderation.uncoveredCells).toBeLessThan(moderation.totalCells)
    expect(moderation.openReports).toBe(0)
  }, 60_000)

  /**
   * Org đang mở mà không còn manager — con số cảnh báo cho lỗ hổng "không có sàn ≥1 manager".
   *
   * Thu hồi thẳng trong DB chứ không qua API: đường API (`role-grant.revoke`) là thứ đáng lẽ
   * phải CHẶN việc này, và test ở đây không nói nó được phép hay không — nó chỉ khẳng định khi
   * trạng thái đó tồn tại thì bàn master nhìn ra.
   */
  it('nhìn ra org đang mở mà không còn manager nào', async () => {
    const before = (await get(master.token).expect(200)).body.data.organizations
    expect(before.withoutManager).toBe(0)

    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    await RoleGrant.updateMany(
      { userId: ownerA.id, scopeType: 'org' },
      { revokedAt: new Date(), revokedBy: null },
    ).exec()

    const after = (await get(master.token).expect(200)).body.data.organizations
    expect(after.withoutManager).toBe(1)
    // `pendingAdmin` không được nhích: org này ĐÃ từng có admin, nó không quay về trạng thái đó.
    expect(after.pendingAdmin).toBe(0)
  }, 60_000)
})
