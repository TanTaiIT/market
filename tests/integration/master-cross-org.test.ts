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
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Master ĐỌC xuyên tổ chức khi chưa chọn org.
 *
 * Quyền của master là toàn hệ thống, nhưng "duyệt tin" vẫn là câu hỏi "hàng đợi của ai". Bắt
 * họ chọn một org TRƯỚC KHI ĐƯỢC NHÌN là trộn hai chuyện: quyền (họ thừa) với phạm vi (họ chưa
 * chỉ). `requireOrgReadOrMaster` gỡ đúng chỗ đó bằng cách nới `readableOrgIds`.
 *
 * Bài test nguy hiểm nhất ở cuối file: nới cho master KHÔNG được nới cho ai khác. `tenantPlugin`
 * là thứ duy nhất đứng giữa dữ liệu hai trường, và nó vẫn phải lọc y như trước.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let adminA: TestUser
let adminB: TestUser
let outsider: TestUser
let categoryId = ''

const SLUG_A = 'truong-a'
const SLUG_B = 'truong-b'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

/** Người ngoài đề xuất tin vào org — `orgSlug` trong body, đúng đường của người không phải thành viên. */
async function postTo(slug: string, title: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(outsider))
    .send({ ...listingPayload(title, categoryId), orgSlug: slug })
    .expect(201)
  return res.body.data._id
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Xe cộ', 'xe-co')
  master = await makeMaster(app)
  adminA = await registerUser(app, 'admin-a@truong.local', 'Quản trị A')
  adminB = await registerUser(app, 'admin-b@truong.local', 'Quản trị B')
  outsider = await registerUser(app, 'nguoi-ngoai@example.com', 'Người ngoài')

  await createOrg(app, master.token, {
    name: 'Trường A',
    slug: SLUG_A,
    ownerEmail: adminA.email,
  })
  await createOrg(app, master.token, {
    name: 'Trường B',
    slug: SLUG_B,
    ownerEmail: adminB.email,
  })

  await postTo(SLUG_A, 'Xe đạp của trường A')
  await postTo(SLUG_B, 'Xe đạp của trường B')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const titlesOf = (body: { data: { title: string }[] }) => body.data.map((l) => l.title)

describe('Master chưa chọn org — đọc được mọi tổ chức', () => {
  it('hàng đợi duyệt tin gộp tin của CẢ HAI trường, không cần X-Org-Slug', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .set(bearer(master))
      .expect(200)

    const titles = titlesOf(res.body)
    expect(titles).toContain('Xe đạp của trường A')
    expect(titles).toContain('Xe đạp của trường B')
  })

  it('danh sách báo cáo cũng mở xuyên tổ chức', async () => {
    await request(app).get('/api/v1/reports').set(bearer(master)).expect(200)
  })

  it('nhật ký hoạt động cũng vậy', async () => {
    await request(app).get('/api/v1/moderation/activity').set(bearer(master)).expect(200)
  })

  /**
   * Chọn org rồi thì master thu về đúng org đó — nếu không, bộ chọn tổ chức trên UI thành nút
   * trang trí: bấm vào mà danh sách không đổi thì người dùng không tin nó nữa.
   */
  it('chọn org rồi thì thu hẹp lại đúng org đó', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .set(orgAuth(master.token, SLUG_A))
      .expect(200)

    const titles = titlesOf(res.body)
    expect(titles).toContain('Xe đạp của trường A')
    expect(titles).not.toContain('Xe đạp của trường B')
  })
})

describe('Cách ly tenant KHÔNG bị nới theo', () => {
  /**
   * Chốt quan trọng nhất của cả file. `requireOrgReadOrMaster` nới `readableOrgIds`, mà đó
   * đúng là thứ `tenantPlugin` dùng để tách dữ liệu hai trường — nới nhầm cho người không phải
   * master là thủng ngay ranh giới đó.
   */
  it('quản trị trường A KHÔNG thấy tin của trường B', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .set(orgAuth(adminA.token, SLUG_A))
      .expect(200)

    const titles = titlesOf(res.body)
    expect(titles).toContain('Xe đạp của trường A')
    expect(titles).not.toContain('Xe đạp của trường B')
  })

  /**
   * Quản trị A có ĐÚNG MỘT membership nên BE tự suy ra org của họ (`resolveOrganization`) —
   * không gửi header vẫn vào được, và đó là hành vi đúng. Thứ phải chốt không phải mã trạng
   * thái mà là NỘI DUNG: đường tự-suy-ra đó tuyệt đối không được rơi vào nhánh đọc-tất-cả
   * vừa mở cho master.
   */
  it('quản trị A không gửi header vẫn chỉ thấy trường mình', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .set(bearer(adminA))
      .expect(200)

    const titles = titlesOf(res.body)
    expect(titles).toContain('Xe đạp của trường A')
    expect(titles).not.toContain('Xe đạp của trường B')
  })

  it('người dùng thường không chọn org cũng 403', async () => {
    const res = await request(app).get('/api/v1/moderation/listings').set(bearer(outsider))
    expect(res.status).toBe(403)
  })

  /** Nới là nới ĐỌC. Ghi mà không chỉ ra org thì vẫn phải hỏng — ghi thì phải biết ghi vào đâu. */
  it('master chưa chọn org vẫn không GHI xuyên tổ chức được', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(bearer(master))
      .send({ title: 'Thông báo', body: 'gửi cho ai?' })

    expect(res.status).toBe(403)
  })
})
