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
  orgIdOf,
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
/** Danh mục CHƯA ai phụ trách — từ khi 'một ô một người' thành luật, ca cấp quyền nào cũng
    cần một ô trống của riêng nó, không mượn ô của `catManager` được nữa. */
let spare = ''
const HCM = 'Hồ Chí Minh'
const ORG = 'truong-cong-khai'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  jobs = await createCategory('Việc làm', 'viec-lam')
  phones = await createCategory('Điện thoại', 'dien-thoai')
  spare = await createCategory('Đồ gia dụng', 'do-gia-dung')

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
    key: ORG,
    ownerEmail: orgOwner.email,
    provinceCode: HCM,
  })
  const { addMember } = await import('../helpers/fixtures')
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findById(orgIdOf(ORG)).lean().exec()
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
    .send({ ...listingPayload(title, categoryId), reach: 'marketplace', provinceCode: HCM })
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
      'X-Org-Id': orgIdOf(ORG),
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

  it('master duyệt được, KHÔNG cần mượn id nhóm nào', async () => {
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
      'X-Org-Id': orgIdOf(ORG),
    }).expect(201)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(orgAuth(orgOwner.token, ORG))
      .send({ status: 'active' })
      .expect(403)

    expect((await statusOf(created.body.data._id))?.status).toBe('pending')
  }, 60_000)
})

/**
 * §5.3 sau khi bỏ tầng cấp phó: manager danh mục KHÔNG cấp được cho ai — kể cả trong đúng ô
 * của mình — và vai trò `staff` không còn cấp mới được. Chỉ master đặt người phụ trách; người
 * đó thường chẳng thuộc tổ chức nào nên `userEmail` vẫn là đường tự nhiên để trỏ tới họ.
 */
describe('Trục công khai — chỉ master cấp quyền, không còn staff', () => {
  /** Người sắp được giao việc — cố tình KHÔNG thuộc nhóm nào, đúng ca danh bạ không có ai. */
  let helper: TestUser

  beforeAll(async () => {
    helper = await registerUser(app, 'helper@pub.local', 'Trợ lý duyệt tin')
  })

  const grant = (who: TestUser, body: Record<string, unknown>) =>
    request(app).post('/api/v1/role-grants').set(bearer(who)).send(body)
  // Hàm, không phải object hằng: `jobs` chỉ có giá trị sau `beforeAll`, đọc lúc khai báo là ''.
  const helperManager = () => ({
    role: 'manager',
    scopeType: 'category_province',
    categoryId: spare,
    provinceCodes: [HCM],
  })

  it('manager danh mục cấp cho người khác → 403, kể cả đúng ô của mình', async () => {
    // Ô của CHÍNH `catManager` (jobs × HCM) — 403 đến từ thẩm quyền, không từ chuyện ô đã có
    // người: cấp quyền trên trục danh mục là việc của một mình master.
    await grant(catManager, {
      userEmail: helper.email,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
    }).expect(403)
  }, 60_000)

  it('`staff` đã bỏ: master gửi role staff → 400, không phải 403', async () => {
    await grant(master, { ...helperManager(), userEmail: helper.email, role: 'staff' }).expect(400)
  }, 60_000)

  it('master cấp manager bằng email → 201, đúng người', async () => {
    const res = await grant(master, { ...helperManager(), userEmail: helper.email }).expect(201)
    expect(res.body.data.userId).toBe(helper.id)
    expect(res.body.data.categoryId).toBe(spare)
  }, 60_000)

  it('email chưa có tài khoản → 404, không tạo grant treo', async () => {
    await grant(master, { ...helperManager(), userEmail: 'khong-ton-tai@pub.local' }).expect(404)
  }, 60_000)

  it('gửi cả userId lẫn userEmail → 400: hai định danh có thể trỏ hai người', async () => {
    await grant(master, {
      ...helperManager(),
      userId: helper.id,
      userEmail: 'khac@pub.local',
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
        reach: 'marketplace',
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
        reach: 'marketplace',
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
    const org = await Organization.findById(orgIdOf(ORG)).lean().exec()
    const orgId = org!._id.toString()

    const poster = await freshUser()
    await addMember(poster.id, orgId)
    const created = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(poster.token, ORG))
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

/**
 * AI PHỤ TRÁCH DANH MỤC NÀO — bảng master mở để biết gọi ai, và để thu hồi.
 *
 * Trước khi có route này, câu hỏi đó không trả lời được từ trong app: `/moderation/coverage`
 * chỉ nói ô CÓ hay KHÔNG có người, `/role-grants/mine` chỉ trả quyền của chính người gọi. Hệ
 * quả kèm theo là `DELETE /role-grants/:id` — vốn đã cho master thu hồi quyền của bất kỳ ai —
 * nằm im không dùng được, vì không có đường nào lấy `id` của người khác.
 */
describe('Bảng phụ trách trục danh mục', () => {
  const list = (who: TestUser, query = '') =>
    request(app).get(`/api/v1/role-grants/category-axis${query}`).set(bearer(who))

  it('CHỈ master đọc được — bảng này mang tên và email của cả hệ thống', async () => {
    await list(master).expect(200)
    // Chính người phụ trách danh mục cũng không đọc: họ không cần danh bạ của mọi ô khác.
    await list(catManager).expect(403)
    await list(orgOwner).expect(403)
  }, 60_000)

  it('trả đủ danh tính người giữ và `id` để thu hồi', async () => {
    const rows = (await list(master).expect(200)).body.data
    const mine = rows.find((r: { userId: string }) => r.userId === catManager.id)

    expect(mine).toBeTruthy()
    expect(mine.holderName).toBe('Phụ trách Việc làm HCM')
    expect(mine.holderEmail).toContain('@')
    expect(mine.holderActive).toBe(true)
    expect(mine.categoryName).toBeTruthy()
    // `id` là thứ DUY NHẤT `DELETE /role-grants/:id` nhận — thiếu nó thì bảng chỉ để nhìn.
    expect(typeof mine.id).toBe('string')
  }, 60_000)

  it('lọc theo danh mục thu hẹp đúng, không nuốt mất ai', async () => {
    const all = (await list(master).expect(200)).body.data
    const onlyJobs = (await list(master, `?categoryId=${jobs}`).expect(200)).body.data

    expect(onlyJobs.length).toBeGreaterThan(0)
    expect(onlyJobs.length).toBeLessThan(all.length)
    expect(onlyJobs.every((r: { categoryId: string }) => r.categoryId === jobs)).toBe(true)
  }, 60_000)

  /**
   * Grant TOÀN QUỐC (`provinceCodes` rỗng) phải khớp MỌI tỉnh khi lọc theo tỉnh.
   *
   * Đây là ca dễ sai nhất: một `$in` suông trên `provinceCodes` sẽ trượt hẳn nó, và bảng đi
   * tìm người phụ trách lại giấu đúng người phủ rộng nhất — master kết luận ô đó trống.
   */
  it('grant toàn quốc khớp mọi tỉnh khi lọc theo tỉnh', async () => {
    const nationwide = await registerUser(app, 'toan-quoc@pub.local', 'Người phủ toàn quốc')
    await grantRole({
      userId: nationwide.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [],
    })

    const rows = (await list(master, '?province=Hà Nội').expect(200)).body.data
    expect(rows.some((r: { userId: string }) => r.userId === nationwide.id)).toBe(true)
    // `catManager` chỉ phủ HCM nên KHÔNG được lọt vào kết quả của Hà Nội.
    expect(rows.some((r: { userId: string }) => r.userId === catManager.id)).toBe(false)
  }, 60_000)

  it('master thu hồi được grant của người khác bằng `id` lấy từ bảng này', async () => {
    const victim = await registerUser(app, 'sap-bi-go@pub.local', 'Người sắp bị gỡ')
    await grantRole({
      userId: victim.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: phones,
      provinceCodes: [HCM],
    })

    const row = (await list(master).expect(200)).body.data.find(
      (r: { userId: string }) => r.userId === victim.id,
    )
    expect(row).toBeTruthy()

    await request(app).delete(`/api/v1/role-grants/${row.id}`).set(bearer(master)).expect(200)

    const after = (await list(master).expect(200)).body.data
    expect(after.some((r: { userId: string }) => r.userId === victim.id)).toBe(false)
  }, 60_000)
})

/**
 * SỬA PHẠM VI thay vì gỡ rồi cấp lại.
 *
 * Gỡ-rồi-cấp làm đứt vết kiểm toán (`grantedAt` nhảy về hôm nay) và để lại một khoảng ô đó
 * không ai phụ trách. `PATCH` giữ nguyên `id` lẫn `grantedAt`.
 *
 * Ca cuối là chốt AN TOÀN, không phải chốt tiện dụng: cho phép biến một grant `org` thành
 * `category_province` sẽ lấy đi quản trị cuối cùng của một nhóm mà KHÔNG chạm
 * `usableOrgAdmins` — chốt đó nằm trong `revoke`, và một lượt sửa không đi qua đó.
 */
describe('Sửa phạm vi phụ trách', () => {
  const patch = (who: TestUser, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/role-grants/${id}`).set(bearer(who)).send(body)

  const axisRow = async (userId: string) =>
    (
      await request(app).get('/api/v1/role-grants/category-axis').set(bearer(master)).expect(200)
    ).body.data.find((r: { userId: string }) => r.userId === userId)

  it('nâng từ tầng PHƯỜNG lên cả tỉnh — giữ nguyên id và grantedAt', async () => {
    const who = await registerUser(app, 'nang-cap@pub.local', 'Người được nâng')
    // Danh mục riêng: ca này nói về việc NÂNG TẦNG, không về việc chia ô với ai.
    const solo = await createCategory('Nội thất', 'noi-that')
    await grantRole({
      userId: who.id,
      role: 'manager',
      scopeType: 'category_ward',
      categoryId: solo,
      provinceCodes: [HCM],
      wardCodes: ['Phường Bến Thành'],
    })

    const before = await axisRow(who.id)
    expect(before.scopeType).toBe('category_ward')

    await patch(master, before.id, {
      scopeType: 'category_province',
      categoryId: solo,
      provinceCodes: [HCM],
      wardCodes: [],
    }).expect(200)

    const after = await axisRow(who.id)
    expect(after.scopeType).toBe('category_province')
    expect(after.wardCodes).toEqual([])
    // Sửa, không phải cấp lại: hai mốc này phải đứng yên.
    expect(after.id).toBe(before.id)
    expect(after.grantedAt).toBe(before.grantedAt)
  }, 60_000)

  it('phạm vi sai hình dạng bị model chặn — 400, grant không nhúc nhích', async () => {
    const row = await axisRow(catManager.id)

    // `category_ward` đòi ĐÚNG một tỉnh và ít nhất một phường (`enforceScopeShape`).
    await patch(master, row.id, {
      scopeType: 'category_ward',
      categoryId: jobs,
      provinceCodes: [HCM],
      wardCodes: [],
    }).expect(400)

    expect((await axisRow(catManager.id)).scopeType).toBe('category_province')
  }, 60_000)

  it('không phải master → 403', async () => {
    const row = await axisRow(catManager.id)
    await patch(catManager, row.id, {
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
      wardCodes: [],
    }).expect(403)
  }, 60_000)

  /** Đổi TRỤC phải đi qua thu hồi + cấp lại, để chốt "org luôn còn một quản trị" còn chạy. */
  it('grant trục ORG không sửa được bằng cửa này — 400', async () => {
    const managers = (
      await request(app)
        .get(`/api/v1/organizations/${orgIdOf(ORG)}/managers`)
        .set(bearer(master))
        .expect(200)
    ).body.data
    expect(managers.length).toBeGreaterThan(0)

    await patch(master, managers[0].grantId, {
      scopeType: 'category_province',
      categoryId: jobs,
      provinceCodes: [HCM],
      wardCodes: [],
    }).expect(400)
  }, 60_000)
})

/**
 * MỘT Ô, MỘT NGƯỜI PHỤ TRÁCH.
 *
 * Index unique trên model khoá theo `userId` nên nó chỉ chặn một người được cấp hai lần; hai
 * NGƯỜI khác nhau cùng một ô thì lọt qua nó. Hệ quả không phải là quyền rộng hơn mà là không ai
 * chịu trách nhiệm: mỗi tin trong ô có hai người cùng duyệt được, và cả hai đều tưởng người kia
 * đã xem.
 *
 * Hai ca giữa là hai ca mà một phép so `provinceCodes` bằng nhau sẽ cho qua — chúng là lý do
 * chốt này phải hỏi "hai phạm vi có giao nhau không" chứ không phải "hai phạm vi có giống nhau
 * không".
 */
describe('Một ô chỉ có một người phụ trách', () => {
  let rival: TestUser
  /*
   * Danh mục RIÊNG cho cả khối này. `jobs` đã bị vài fixture phía trên chiếm bằng `grantRole`
   * (ghi thẳng qua model, không đi qua chốt) — trong đó có một grant TOÀN QUỐC, thứ đè lên mọi
   * ô của danh mục đó. Mượn `jobs` là mỗi ca dưới đây đo lẫn dữ liệu của ca khác.
   */
  let cell = ''
  let hanoiGrantId = ''
  const HANOI = 'Hà Nội'
  const BENTHANH = 'Phường Bến Thành'

  const give = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/role-grants').set(bearer(master)).send(body)
  const rescope = (id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/role-grants/${id}`).set(bearer(master)).send(body)

  beforeAll(async () => {
    rival = await registerUser(app, 'doi-thu@pub.local', 'Người thứ hai')
    cell = await createCategory('Xe máy', 'xe-may')
    // Người giữ ô gốc, cấp thẳng qua model: đây là TIỀN ĐỀ của mọi ca dưới, không phải một
    // lượt cấp đang được đo.
    await grantRole({
      userId: catManager.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [HCM],
    })
  })

  it('cấp manager thứ hai cho đúng ô đã có người → 409, kèm TÊN người đang giữ', async () => {
    const res = await give({
      userEmail: rival.email,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [HCM],
    }).expect(409)

    expect(res.body.message).toContain('Phụ trách Việc làm HCM')
  }, 60_000)

  /** Hai bản ghi trông khác hẳn nhau, nhưng grant cấp tỉnh phủ trọn mọi phường của tỉnh đó. */
  it('cấp cấp PHƯỜNG trong tỉnh đã có người cấp tỉnh → 409', async () => {
    await give({
      userEmail: rival.email,
      role: 'manager',
      scopeType: 'category_ward',
      categoryId: cell,
      provinceCodes: [HCM],
      wardCodes: [BENTHANH],
    }).expect(409)
  }, 60_000)

  /** `provinceCodes` rỗng là TOÀN QUỐC, nên nó đè lên mọi ô đã có người của danh mục đó. */
  it('cấp TOÀN QUỐC khi một tỉnh đã có người → 409', async () => {
    await give({
      userEmail: rival.email,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [],
    }).expect(409)
  }, 60_000)

  it('nhưng tỉnh KHÁC trong cùng danh mục thì cấp được → 201', async () => {
    const res = await give({
      userEmail: rival.email,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [HANOI],
    }).expect(201)

    hanoiGrantId = res.body.data.id
  }, 60_000)

  it('sửa phạm vi sang ô đã có người cũng bị chặn → 409', async () => {
    await rescope(hanoiGrantId, {
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [HCM],
      wardCodes: [],
    }).expect(409)
  }, 60_000)

  /** Chốt xuôi: không loại chính nó ra khỏi phép so thì MỌI lượt sửa đều tự đụng phạm vi cũ. */
  it('sửa mà vẫn giữ tỉnh cũ thì không tự đụng chính mình → 200', async () => {
    await rescope(hanoiGrantId, {
      scopeType: 'category_province',
      categoryId: cell,
      provinceCodes: [HANOI, 'Hải Phòng'],
      wardCodes: [],
    }).expect(200)
  }, 60_000)
})
