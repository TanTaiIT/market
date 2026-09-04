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
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Phụ trách ô (Việc làm × TP.HCM) — không thuộc nhóm nào, đúng hình mẫu người gác trục danh mục. */
let catManager: TestUser
/** Phụ trách ô KHÁC — dùng để chứng minh phạm vi vẫn được tôn trọng. */
let otherCatManager: TestUser
let orgOwner: TestUser
/** Người bán không thuộc nhóm nào — nhân vật của lỗ hổng cũ. */
let loneSeller: TestUser
let orgMember: TestUser

let jobs = ''
let phones = ''
const HCM = 'Hồ Chí Minh'
const SLUG = 'truong-cong-khai'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  jobs = await createCategory('Việc làm', 'viec-lam')
  phones = await createCategory('Điện thoại', 'dien-thoai')

  master = await makeMaster(app)
  catManager = await registerUser(app, 'catman@pub.local', 'Phụ trách Việc làm HCM')
  otherCatManager = await registerUser(app, 'other@pub.local', 'Phụ trách Điện thoại HCM')
  orgOwner = await registerUser(app, 'owner@pub.local', 'Chủ nhóm')
  orgMember = await registerUser(app, 'member@pub.local', 'Thành viên nhóm')
  loneSeller = await registerUser(app, 'lone@pub.local', 'Người bán không nhóm')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(orgMember.id, 0)
  await setTrustLevel(loneSeller.id, 0)

  await createOrg(app, master.token, {
    name: 'Trường công khai',
    slug: SLUG,
    ownerEmail: orgOwner.email,
    provinceCode: HCM,
  })
  const { addMember } = await import('../helpers/fixtures')
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findOne({ slug: SLUG }).lean().exec()
  await addMember(orgMember.id, org!._id.toString())

  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId: jobs,
    provinceCodes: [HCM],
  })
  await grantRole({
    userId: otherCatManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId: phones,
    provinceCodes: [HCM],
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function postPublic(who: TestUser, title: string, categoryId: string, headers = {}) {
  return request(app)
    .post('/api/v1/listings')
    .set({ ...bearer(who), ...headers })
    .send({ ...listingPayload(title, categoryId), visibility: 'public', provinceCode: HCM })
}

const statusOf = async (id: string) => {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const doc = await runUnscoped('test đọc status', () =>
    Listing.findById(id).select('status organizationId').lean().exec(),
  )
  return doc
}

describe('Trục công khai — người phụ trách danh mục duyệt được', () => {
  it('tin của người KHÔNG thuộc nhóm nào: thấy, và bấm duyệt được', async () => {
    const created = await postPublic(loneSeller, 'Tuyển thợ hàn gấp', jobs).expect(201)
    const id = created.body.data._id
    expect(created.body.data.status).toBe('pending')

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(catManager))
      .expect(200)
    expect(queue.body.data.map((l: { _id: string }) => l._id)).toContain(id)

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(bearer(catManager))
      .send({ status: 'active' })
      .expect(200)

    expect((await statusOf(id))?.status).toBe('active')
  }, 60_000)

  /**
   * Ca chặn thứ hai của lỗ cũ: tin công khai MANG BADGE nhóm. Nhánh ghi của `tenantPlugin` chỉ
   * cho đụng `organizationId: null` hoặc org trong scope, nên trước đây người phụ trách danh
   * mục (không có org trong scope) vẫn bị chặn ở tầng dữ liệu dù đã qua được middleware.
   */
  it('tin công khai của THÀNH VIÊN nhóm — vẫn duyệt được dù tin mang organizationId', async () => {
    const created = await postPublic(orgMember, 'Tuyển kế toán cho trường', jobs, {
      'X-Org-Slug': SLUG,
    }).expect(201)
    const id = created.body.data._id
    expect((await statusOf(id))?.organizationId).not.toBeNull()

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(bearer(catManager))
      .send({ status: 'active' })
      .expect(200)

    expect((await statusOf(id))?.status).toBe('active')
  }, 60_000)

  it('master duyệt được, KHÔNG cần mượn slug nhóm nào', async () => {
    const created = await postPublic(loneSeller, 'Tuyển bảo vệ ca đêm', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(master))
      .send({ status: 'active' })
      .expect(200)
  }, 60_000)

  it('gỡ tin cũng chạy trên trục công khai', async () => {
    const created = await postPublic(loneSeller, 'Tin sẽ bị gỡ', jobs).expect(201)

    await request(app)
      .delete(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(catManager))
      .expect(200)
  }, 60_000)
})

describe('Trục công khai — phạm vi KHÔNG được nới rộng', () => {
  it('phụ trách danh mục khác thì không đụng được', async () => {
    const created = await postPublic(loneSeller, 'Tuyển đầu bếp', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(otherCatManager))
      .send({ status: 'active' })
      .expect(403)

    expect((await statusOf(created.body.data._id))?.status).toBe('pending')
  }, 60_000)

  it('người dùng thường không có cửa nào — chặn ngay ở middleware', async () => {
    const created = await postPublic(loneSeller, 'Tuyển lễ tân', jobs).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(bearer(loneSeller))
      .send({ status: 'active' })
      .expect(403)
  }, 60_000)

  it('quản trị nhóm KHÔNG ghim được tin công khai lên bảng chung — hai trục vẫn tách bạch', async () => {
    const created = await postPublic(orgMember, 'Tin công khai của thành viên', jobs, {
      'X-Org-Slug': SLUG,
    }).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(orgAuth(orgOwner.token, SLUG))
      .send({ status: 'active' })
      .expect(403)

    expect((await statusOf(created.body.data._id))?.status).toBe('pending')
  }, 60_000)
})

/**
 * §5.3 nói manager danh mục chia tải bằng cách cấp `staff` trong scope của mình — nhưng người
 * họ định giao việc thường chẳng thuộc tổ chức nào, nên không có danh bạ nào tra ra `userId`.
 * `userEmail` là đường duy nhất còn lại, và nó phải chịu đúng luật `covers()` như `userId`.
 */
describe('Trục công khai — manager danh mục cấp staff bằng email', () => {
  /** Người sắp được giao việc — cố tình KHÔNG thuộc nhóm nào, đúng ca danh bạ không có ai. */
  let helper: TestUser

  beforeAll(async () => {
    helper = await registerUser(app, 'helper@pub.local', 'Trợ lý duyệt tin')
  })

  const grant = (who: TestUser, body: Record<string, unknown>) =>
    request(app).post('/api/v1/role-grants').set(bearer(who)).send(body)

  it('cấp staff cho đúng ô của mình, chỉ bằng email', async () => {
    const res = await grant(catManager, {
      userEmail: helper.email,
      role: 'staff',
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
    }).expect(201)

    expect(res.body.data.userId).toBe(helper.id)
    expect(res.body.data.categoryId).toBe(jobs)
  }, 60_000)

  it('email chưa có tài khoản → 404, không tạo grant treo', async () => {
    await grant(catManager, {
      userEmail: 'khong-ton-tai@pub.local',
      role: 'staff',
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
    }).expect(404)
  }, 60_000)

  it('sang danh mục khác vẫn 403 — email không nới được phạm vi', async () => {
    await grant(catManager, {
      userEmail: helper.email,
      role: 'staff',
      scopeType: 'category_province',
      categoryId: phones,
      provinceCodes: [HCM],
    }).expect(403)
  }, 60_000)

  it('gửi cả userId lẫn userEmail → 400: hai định danh có thể trỏ hai người', async () => {
    await grant(catManager, {
      userId: helper.id,
      userEmail: 'khac@pub.local',
      role: 'staff',
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
    }).expect(400)
  }, 60_000)
})

/**
 * Tầng phường end-to-end: master cấp ô (danh mục × phường), người được cấp chỉ thấy đúng ô đó.
 *
 * Dùng Lâm Đồng vì hai phường trong ví dụ nghiệp vụ — La Gi và Phước Hội — thật sự thuộc tỉnh
 * này sau sáp nhập 01/07/2025. Test bám dữ liệu thật để không hợp lệ hoá một cặp (tỉnh, phường)
 * không tồn tại; `isWardOfProvince` sẽ chặn ngay nếu cặp sai.
 */
describe('Trục công khai — tầng phường', () => {
  const LAMDONG = 'Lâm Đồng'
  const LAGI = 'Phường La Gi'
  const PHUOCHOI = 'Phường Phước Hội'

  let wardManager: TestUser
  /** Người bán riêng cho nhóm test này: bậc 1 = hạn mức 5 tin chờ, đủ cho 5 lượt đăng dưới đây. */
  let seller: TestUser

  beforeAll(async () => {
    wardManager = await registerUser(app, 'ward@pub.local', 'Phụ trách La Gi')
    seller = await registerUser(app, 'ld-seller@pub.local', 'Người bán Lâm Đồng')
    await setTrustLevel(seller.id, 1)
    await grantRole({
      userId: wardManager.id,
      role: 'manager',
      scopeType: 'category_ward',
      categoryId: jobs,
      provinceCodes: [LAMDONG],
      wardCodes: [LAGI],
    })
  })

  const postIn = (ward: string, title: string) =>
    request(app)
      .post('/api/v1/listings')
      .set(bearer(seller))
      .send({
        ...listingPayload(title, jobs),
        visibility: 'public',
        provinceCode: LAMDONG,
        location: { province: LAMDONG, ward },
      })

  it('chỉ thấy tin của phường mình, không thấy phường khác CÙNG tỉnh', async () => {
    const mine = await postIn(LAGI, 'Tuyển thợ ở La Gi').expect(201)
    const other = await postIn(PHUOCHOI, 'Tuyển thợ ở Phước Hội').expect(201)

    const queue = await request(app)
      .get('/api/v1/moderation/public-queue')
      .set(bearer(wardManager))
      .expect(200)

    const ids = queue.body.data.map((l: { _id: string }) => l._id)
    expect(ids).toContain(mine.body.data._id)
    expect(ids).not.toContain(other.body.data._id)
  }, 60_000)

  it('duyệt được tin phường mình, 403 với phường khác', async () => {
    const mine = await postIn(LAGI, 'Tin La Gi sẽ duyệt').expect(201)
    const other = await postIn(PHUOCHOI, 'Tin Phước Hội ngoài ô').expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${mine.body.data._id}`)
      .set(bearer(wardManager))
      .send({ status: 'active' })
      .expect(200)

    await request(app)
      .patch(`/api/v1/moderation/listings/${other.body.data._id}`)
      .set(bearer(wardManager))
      .send({ status: 'active' })
      .expect(403)
  }, 60_000)

  it('tin công khai THIẾU phường bị chặn ngay lúc đăng', async () => {
    await request(app)
      .post('/api/v1/listings')
      .set(bearer(seller))
      .send({
        title: 'Tin thiếu phường xã',
        description: 'Mô tả đủ dài cho validation',
        price: 1_000_000,
        categoryId: jobs,
        images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
        visibility: 'public',
        provinceCode: LAMDONG,
      })
      .expect(400)
  }, 60_000)

  it('master vẫn duyệt được mọi phường — fallback của ô chưa có ai phụ trách', async () => {
    const other = await postIn(PHUOCHOI, 'Tin Phước Hội cho master').expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${other.body.data._id}`)
      .set(bearer(master))
      .send({ status: 'active' })
      .expect(200)
  }, 60_000)

  it('tổng quan trục danh mục đếm theo đúng ô của mình', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/public-overview')
      .set(bearer(wardManager))
      .expect(200)

    // Không so số tuyệt đối: các nhóm test trên cùng file đã tạo/duyệt tin trong ô này, nên số
    // đúng là số đang thay đổi. Điều cần chốt là endpoint mở được và trả đúng hình dạng.
    expect(res.body.data).toHaveProperty('pending')
    expect(res.body.data).toHaveProperty('trend')
    expect(Array.isArray(res.body.data.trend)).toBe(true)
  }, 60_000)
})

/**
 * ĐẨY TIN — miễn phí, không qua gói nào. Đúng ba hạng: master, người phụ trách danh mục của
 * tin, quản trị nhóm sở hữu tin.
 *
 * Ma trận quyền LÀ toàn bộ feature này, nên nó phải nằm trong test chứ không phải trong mô tả.
 * Hai ca dễ nới lỏng nhất lúc sửa sau này được chốt tường minh: phụ trách danh mục KHÁC, và
 * staff nhóm — staff duyệt được tin nhưng không được đẩy, vì đẩy tin là lấy chỗ của tin người
 * khác trên bảng.
 */
describe('Đẩy tin lên đầu bảng', () => {
  let seq = 0
  /** Tài khoản mới ở bậc trần uy tín → tin công khai lên bảng ngay, không qua hàng đợi. */
  const freshUser = () => registerUser(app, `bump${(seq += 1)}@pub.local`, `Người bán ${seq}`)

  const bump = (who: TestUser, id: string) =>
    request(app).post(`/api/v1/listings/${id}/bump`).set(bearer(who))

  const feedTitles = async () => {
    const res = await request(app)
      .get('/api/v1/listings')
      .set(bearer(master))
      .query({ category: jobs })
      .expect(200)
    return res.body.data.map((l: { title: string }) => l.title)
  }

  /** Tin công khai ĐANG hiển thị. Chốt luôn tiền đề `active` — cả nhóm test dựa vào nó. */
  const activePublic = async (title: string) => {
    const seller = await freshUser()
    const res = await postPublic(seller, title, jobs).expect(201)
    const id = res.body.data._id as string
    expect((await statusOf(id))?.status).toBe('active')
    return id
  }

  it('master đẩy được, và tin nhảy lên đầu bảng', async () => {
    const older = await activePublic('Tin cũ cần kéo lên')
    await activePublic('Tin mới hơn')

    // Trước khi đẩy: tin mới hơn đứng trên, vì `rankAt` mặc định bằng lúc tạo.
    expect((await feedTitles())[0]).toBe('Tin mới hơn')

    await bump(master, older).expect(200)

    expect((await feedTitles())[0]).toBe('Tin cũ cần kéo lên')
  }, 60_000)

  it('phụ trách danh mục đẩy được tin trong ô của mình', async () => {
    const id = await activePublic('Tuyển thợ điện')
    await bump(catManager, id).expect(200)
  }, 60_000)

  it('phụ trách danh mục KHÁC bị chặn — phạm vi vẫn được tôn trọng', async () => {
    const id = await activePublic('Tuyển thợ nước')
    const res = await bump(otherCatManager, id)

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/phụ trách danh mục/)
  }, 60_000)

  it('người bán thường không đẩy được tin của CHÍNH mình', async () => {
    const seller = await freshUser()
    const created = await postPublic(seller, 'Tin tự đẩy', jobs).expect(201)

    const res = await bump(seller, created.body.data._id)
    expect(res.status).toBe(403)
  }, 60_000)

  it('tin chưa duyệt không đẩy được — nó chưa ở trên bảng', async () => {
    const created = await postPublic(loneSeller, 'Tin còn chờ duyệt', jobs).expect(201)
    expect((await statusOf(created.body.data._id))?.status).toBe('pending')

    const res = await bump(master, created.body.data._id)
    expect(res.status).toBe(400)
  }, 60_000)

  it('tin nội bộ: quản trị nhóm đẩy được, staff nhóm thì không', async () => {
    const { addMember } = await import('../helpers/fixtures')
    const { Organization } = await import('../../src/features/organization/organization.model')
    const org = await Organization.findOne({ slug: SLUG }).lean().exec()
    const orgId = org!._id.toString()

    const poster = await freshUser()
    await addMember(poster.id, orgId)
    const created = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(poster.token, SLUG))
      .send(listingPayload('Tin nội bộ của trường', jobs))
      .expect(201)
    const id = created.body.data._id as string
    expect((await statusOf(id))?.status).toBe('active')

    // Grant cấp TƯỜNG MINH ở đây chứ không mượn side-effect của `createOrg`: test phải nói ra
    // ĐÚNG grant nào cho quyền đẩy tin, đó mới là thứ đang được kiểm.
    const staff = await freshUser()
    await addMember(staff.id, orgId)
    await grantRole({ userId: staff.id, role: 'staff', scopeType: 'org', orgId })

    const denied = await bump(staff, id)
    expect(denied.status).toBe(403)
    expect(denied.body.message).toMatch(/quản trị nhóm/)

    const groupAdmin = await freshUser()
    await addMember(groupAdmin.id, orgId)
    await grantRole({ userId: groupAdmin.id, role: 'manager', scopeType: 'org', orgId })

    await bump(groupAdmin, id).expect(200)
  }, 60_000)
})
