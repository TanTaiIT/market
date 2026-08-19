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
  grantRole,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let member: TestUser
let catManager: TestUser
let outsider: TestUser
let orgId = ''
let jobsCategory = ''
let booksCategory = ''

const SLUG = 'two-axis-org'
const HCM = 'Hồ Chí Minh'
const HANOI = 'Hà Nội'

const asMember = () => orgAuth(member.token, SLUG)
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

function post(headers: Record<string, string>, body: Record<string, unknown>) {
  return request(app).post('/api/v1/listings').set(headers).send(body)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  jobsCategory = await createCategory('Việc làm', 'viec-lam')
  booksCategory = await createCategory('Sách vở', 'sach-vo')

  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@two-axis.local', 'Owner')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Trường Hai Trục',
      slug: SLUG,
      ownerEmail: owner.email,
      provinceCode: HCM,
    })
  ).id

  member = await registerUser(app, 'member@two-axis.local', 'Thành viên')
  await addMember(member.id, orgId)

  outsider = await registerUser(app, 'outsider@two-axis.local', 'Người ngoài')

  // Manager danh mục "Việc làm" tại TP.HCM — không phụ trách Hà Nội, không phụ trách "Sách vở".
  catManager = await registerUser(app, 'catmanager@two-axis.local', 'Quản lý Việc làm')
  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId: jobsCategory,
    provinceCodes: [HCM],
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Định tuyến theo visibility, không theo org', () => {
  it('tin nội bộ của thành viên nằm ở org, KHÔNG lộ ra trục công khai', async () => {
    const res = await post(asMember(), {
      ...listingPayload('Tin nội bộ của trường', jobsCategory),
      visibility: 'org_internal',
    })

    expect(res.status).toBe(201)
    expect(res.body.data.organizationId).toBe(orgId)
    expect(res.body.data.status).toBe('pending')

    // Manager danh mục phụ trách đúng (Việc làm × TP.HCM) vẫn KHÔNG thấy nó: hai trục tách bạch.
    const queue = await request(app).get('/api/v1/moderation/public-queue').set(bearer(catManager))
    expect(queue.status).toBe(200)
    expect(queue.body.data).toHaveLength(0)
  })

  it('tin công khai của cùng thành viên đó lại rơi vào hàng đợi manager danh mục', async () => {
    const res = await post(asMember(), {
      ...listingPayload('Tin công khai từ trường', jobsCategory),
      visibility: 'public',
    })
    expect(res.status).toBe(201)
    // org vẫn giữ để hiển thị nguồn gốc, nhưng nó không quyết định ai duyệt.
    expect(res.body.data.organizationId).toBe(orgId)
    expect(res.body.data.provinceCode).toBe(HCM)

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(queue.body.data.map((l: { title: string }) => l.title)).toContain(
      'Tin công khai từ trường',
    )
  })

  it('người không thuộc org nào vẫn đăng được tin công khai', async () => {
    const res = await post(bearer(outsider), {
      ...listingPayload('Tin của người không thuộc tổ chức nào', jobsCategory),
      visibility: 'public',
      provinceCode: HCM,
    })

    expect(res.status).toBe(201)
    expect(res.body.data.organizationId).toBeNull()
  })

  it('tin nội bộ mà không đứng trong org nào là vô nghĩa → 400', async () => {
    const res = await post(bearer(outsider), {
      ...listingPayload('Tin nội bộ không org', jobsCategory),
      visibility: 'org_internal',
    })
    expect(res.status).toBe(400)
  })

  it('người ngoài KHÔNG gửi được tin vào org đang tắt nhận tin ngoài', async () => {
    const res = await post(orgAuth(outsider.token, SLUG), {
      ...listingPayload('Tin người ngoài gửi vào trường', jobsCategory),
      visibility: 'org_internal',
    })
    // Không phải thành viên nên scope org không mở -> plugin fail-closed chặn ở tầng dưới.
    expect(res.status).toBe(400)
  })
})

describe('Manager danh mục chỉ thấy ô của mình', () => {
  it('không thấy tin ngoài TỈNH được cấp', async () => {
    await post(bearer(outsider), {
      ...listingPayload('Việc làm ở Hà Nội', jobsCategory),
      visibility: 'public',
      provinceCode: HANOI,
      location: { province: HANOI, ward: 'Phường Cửa Nam' },
    }).expect(201)

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(queue.body.data.map((l: { title: string }) => l.title)).not.toContain(
      'Việc làm ở Hà Nội',
    )
  })

  it('không thấy tin ngoài DANH MỤC được cấp', async () => {
    await post(bearer(outsider), {
      ...listingPayload('Sách giáo khoa lớp 10', booksCategory),
      visibility: 'public',
      provinceCode: HCM,
    }).expect(201)

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(queue.body.data.map((l: { title: string }) => l.title)).not.toContain(
      'Sách giáo khoa lớp 10',
    )
  })

  it('tin của người ngoài gửi vào org ĐỌC ĐƯỢC ở bàn duyệt của org đó', async () => {
    const { Organization } = await import('../../src/features/organization/organization.model')
    const { clearOrganizationCache } =
      await import('../../src/features/organization/organization.repository')
    await Organization.updateOne({ _id: orgId }, { allowOutsiderPosts: true }).exec()
    clearOrganizationCache()

    // Org đích đi trong BODY: người ngoài không có scope org, đúng thiết kế.
    const sent = await post(bearer(outsider), {
      ...listingPayload('Tin người ngoài gửi vào trường', jobsCategory),
      visibility: 'org_internal',
      orgSlug: SLUG,
    })
    expect(sent.status).toBe(201)
    expect(sent.body.data.status).toBe('pending_unverified')

    // Hàng đợi org phải thấy nó — nếu không thì tin nằm trong DB mà không ai duyệt được.
    const queue = await request(app)
      .get('/api/v1/moderation/listings?status=pending_unverified')
      .set(orgAuth(owner.token, SLUG))
      .expect(200)
    expect(queue.body.data.map((l: { title: string }) => l.title)).toContain(
      'Tin người ngoài gửi vào trường',
    )
  })

  it('người không có grant danh mục nào thì bị chặn khỏi hàng đợi', async () => {
    const res = await request(app).get('/api/v1/moderation/public-queue').set(bearer(member))
    expect(res.status).toBe(403)
  })
})

describe('Trang công khai và fallback về master', () => {
  it('khách chưa đăng nhập chỉ thấy tin công khai ĐÃ duyệt', async () => {
    const res = await request(app).get('/api/v1/listings')
    expect(res.status).toBe(200)
    // Mọi tin ở trên đều đang chờ duyệt, nên bảng tin công khai phải rỗng.
    expect(res.body.data).toHaveLength(0)
  })

  it('master thấy ma trận phủ sóng, gồm cả ô chưa có ai phụ trách', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/coverage')
      .set(bearer(master))
      .expect(200)

    expect(res.body.data.totalCells).toBeGreaterThan(0)
    expect(res.body.data.uncovered).toBeGreaterThan(0)

    // Ô (Sách vở × TP.HCM) chưa có ai, và đang có tin tồn — đúng ca §11.1 cảnh báo.
    const cell = res.body.data.cells.find(
      (c: { categoryId: string; provinceCode: string }) =>
        c.categoryId === booksCategory && c.provinceCode === HCM,
    )
    expect(cell).toMatchObject({ hasModerator: false, pending: 1 })
  })

  it('master chuyển được tin sang ô khác, tin quay về đầu hàng đợi mới', async () => {
    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(master))
      .expect(200)
    const hanoiListing = queue.body.data.find(
      (l: { title: string }) => l.title === 'Việc làm ở Hà Nội',
    )

    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${hanoiListing._id}/route`)
      .set(bearer(master))
      .send({ provinceCode: HCM })

    expect(res.status).toBe(200)
    expect(res.body.data.provinceCode).toBe(HCM)

    // Sau khi đổi ô, manager TP.HCM mới nhìn thấy nó.
    const after = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(after.body.data.map((l: { title: string }) => l.title)).toContain('Việc làm ở Hà Nội')
  })

  it('manager danh mục KHÔNG chuyển ô được — đó là quyền của master', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${new mongoose.Types.ObjectId().toString()}/route`)
      .set(bearer(catManager))
      .send({ provinceCode: HCM })
    expect(res.status).toBe(403)
  })
})

/**
 * Quyền DUYỆT bám theo TRỤC của tin, không theo bàn đang mở.
 *
 * `requireOrgModerator` ở tầng route cố tình rộng (rule 5) nên nó chỉ trả lời "có duyệt được
 * thứ gì đó trong org này không". Thiếu chốt ở service thì quản lý org tự ghim được tin công
 * khai lên trang chung, và — vì nhánh đọc công khai cho thấy mọi tin đã duyệt — ẩn được cả tin
 * của người ngoài org. Hai ca đầu ở đây chính là hai lỗ đó.
 */
describe('Duyệt tin — phạm vi theo trục', () => {
  let memberPublic = ''
  let memberInternal = ''
  let outsiderPublic = ''

  beforeAll(async () => {
    const { addMember, publishListing, registerUser } = await import('../helpers/fixtures')

    // Người mới hoàn toàn: `member`/`outsider` ở trên đã dùng hết quota tin chờ duyệt, đăng
    // thêm là 409 chứ không phải lỗi phân quyền — đúng thứ test này KHÔNG muốn đo.
    const poster = await registerUser(app, 'poster@two-axis.local', 'Người đăng')
    await addMember(poster.id, orgId)
    const loner = await registerUser(app, 'loner@two-axis.local', 'Người một mình')
    const asPoster = () => orgAuth(poster.token, SLUG)

    memberPublic = (
      await post(asPoster(), {
        ...listingPayload('Tin công khai cần manager danh mục duyệt', jobsCategory),
        visibility: 'public',
        provinceCode: HCM,
      }).expect(201)
    ).body.data._id

    memberInternal = (
      await post(asPoster(), {
        ...listingPayload('Tin nội bộ của trường', jobsCategory),
        visibility: 'org_internal',
      }).expect(201)
    ).body.data._id

    // Tin đã duyệt của người ngoài org: đọc được từ mọi org qua nhánh công khai của plugin,
    // nên nó là ca chứng minh "đọc được ≠ duyệt được".
    outsiderPublic = (
      await post(bearer(loner), {
        ...listingPayload('Tin của người ngoài mọi tổ chức', jobsCategory),
        visibility: 'public',
        provinceCode: HCM,
      }).expect(201)
    ).body.data._id
    await publishListing(outsiderPublic)
  }, 60_000)

  it('quản lý org KHÔNG ghim được tin công khai của chính thành viên mình', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${memberPublic}`)
      .set(orgAuth(owner.token, SLUG))
      .send({ status: 'active' })

    expect(res.status).toBe(403)
  })

  it('quản lý org KHÔNG ẩn được tin của người ngoài tổ chức', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${outsiderPublic}`)
      .set(orgAuth(owner.token, SLUG))
      .send({ status: 'hidden' })

    expect(res.status).toBe(403)
  })

  it('quản lý org vẫn duyệt bình thường tin NỘI BỘ của org mình', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${memberInternal}`)
      .set(orgAuth(owner.token, SLUG))
      .send({ status: 'active' })

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
  })

  it('có grant đúng ô (danh mục × tỉnh) thì ghim được tin công khai', async () => {
    const { grantRole } = await import('../helpers/fixtures')
    await grantRole({
      userId: owner.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: jobsCategory,
      provinceCodes: [HCM],
    })

    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${memberPublic}`)
      .set(orgAuth(owner.token, SLUG))
      .send({ status: 'active' })

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
  })
})
