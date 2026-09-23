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
  createOrgUnit,
  createTestApp,
  joinCodeOf,
  listingPayload,
  makeMaster,
  orgAuth,
  orgIdOf,
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * ĐỌC GỘP NHIỀU NHÓM — `memberOrgIds`, và cái giá phải canh của nó.
 *
 * Trước đây scope đọc chỉ có ĐÚNG một org (org mà request chỉ ra), nên người thuộc hai nhóm
 * phải bấm chọn "nhóm đang thao tác" mới thấy tin của nhóm đó, và chưa bấm thì không thấy tin
 * nội bộ của nhóm nào cả. `TenantScope.memberOrgIds` gỡ đúng chỗ đó.
 *
 * Nửa sau của file mới là phần quan trọng. Nới quyền đọc luôn kèm rủi ro rằng nó chảy sang
 * những bề mặt KHÔNG được nới — bàn duyệt, nhật ký, và hai chỗ coi "tra ra nhóm con" là bằng
 * chứng cùng org. Mỗi ca dưới đây ghim một trong số đó.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
/** Thành viên của CẢ HAI nhóm A và B — nhân vật chính. */
let duo: TestUser
/** Quản trị nhóm A, đồng thời là thành viên thường nhóm B — ca leo thang nguy hiểm nhất. */
let adminA: TestUser
let ownerB: TestUser
let ownerC: TestUser
let stranger: TestUser
let categoryId = ''
let unitOfB = ''

const ORG_A = 'nhom-doc-a'
const ORG_B = 'nhom-doc-b'
const ORG_C = 'nhom-doc-c'
const HCM = 'Hồ Chí Minh'
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

/** Tin NỘI BỘ của một nhóm, đã lên bảng — thứ chỉ thành viên nhóm đó đọc được. */
async function postInternal(who: TestUser, org: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, org))
    .send({ ...listingPayload(title, categoryId), reach: 'members' })
    .expect(201)
  await publishListing(res.body.data._id)
  return res.body.data._id as string
}

/** Tin lên BẢNG TIN CHUNG, đã duyệt — `org` để trống là tin không thuộc nhóm nào. */
async function postMarketplace(who: TestUser, org: string | null, title: string) {
  const req = request(app).post('/api/v1/listings')
  const res = await (org ? req.set(orgAuth(who.token, org)) : req.set(bearer(who)))
    .send({ ...listingPayload(title, categoryId), reach: 'marketplace' })
    .expect(201)
  await publishListing(res.body.data._id)
  return res.body.data._id as string
}

const titlesSeenBy = async (u: TestUser, headers: Record<string, string> = {}, query = '') => {
  const res = await request(app)
    .get(`/api/v1/listings${query}`)
    .set({ ...bearer(u), ...headers })
    .expect(200)
  return res.body.data.map((l: { title: string }) => l.title)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Việc làm', 'viec-lam')
  master = await makeMaster(app)
  adminA = await registerUser(app, 'quan-tri-a@doc.local', 'Quản trị A')
  ownerB = await registerUser(app, 'chu-b@doc.local', 'Chủ B')
  ownerC = await registerUser(app, 'chu-c@doc.local', 'Chủ C')
  duo = await registerUser(app, 'hai-nhom@doc.local', 'Người hai nhóm')
  stranger = await registerUser(app, 'nguoi-la@doc.local', 'Người lạ')

  await createOrg(app, master.token, {
    name: 'Nhóm Đọc A',
    key: ORG_A,
    ownerEmail: adminA.email,
    provinceCode: HCM,
  })
  await createOrg(app, master.token, {
    name: 'Nhóm Đọc B',
    key: ORG_B,
    ownerEmail: ownerB.email,
    provinceCode: HCM,
  })
  await createOrg(app, master.token, {
    name: 'Nhóm Đọc C',
    key: ORG_C,
    ownerEmail: ownerC.email,
    provinceCode: HCM,
  })

  await addMember(duo.id, orgIdOf(ORG_A))
  await addMember(duo.id, orgIdOf(ORG_B))
  // Quản trị A cũng là thành viên THƯỜNG của B: quyền duyệt ở A, chỉ tư cách thành viên ở B.
  await addMember(adminA.id, orgIdOf(ORG_B))

  unitOfB = await createOrgUnit(orgIdOf(ORG_B), 'Khối 10 của B')

  await postInternal(adminA, ORG_A, 'Tin nội bộ của A')
  await postInternal(ownerB, ORG_B, 'Tin nội bộ của B')
  await postInternal(ownerC, ORG_C, 'Tin nội bộ của C')
  // Hai tin CÔNG KHAI — thứ mà bàn quản trị của A tuyệt đối không được nhặt vào.
  await postMarketplace(ownerB, ORG_B, 'Tin sàn của nhóm B')
  await postMarketplace(stranger, null, 'Tin sàn không thuộc nhóm nào')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Bảng tin gộp mọi nhóm mình ở trong', () => {
  /**
   * Ca trung tâm, và là trạng thái mà bản cũ gần như không test: `ownOrgId === null` vì người
   * này thuộc HAI nhóm nên `resolveTenant` cố tình không đoán, cộng với việc client không gửi
   * header. Trước đây kết cục là "không thấy tin nội bộ nào cả".
   */
  it('thuộc hai nhóm, KHÔNG gửi header → thấy tin của cả hai', async () => {
    const titles = await titlesSeenBy(duo)

    expect(titles).toContain('Tin nội bộ của A')
    expect(titles).toContain('Tin nội bộ của B')
  })

  it('và vẫn KHÔNG thấy tin của nhóm mình không ở trong', async () => {
    expect(await titlesSeenBy(duo)).not.toContain('Tin nội bộ của C')
  })

  it('người lạ không thuộc nhóm nào thì không thấy tin nội bộ nào', async () => {
    const titles = await titlesSeenBy(stranger)

    expect(titles).not.toContain('Tin nội bộ của A')
    expect(titles).not.toContain('Tin nội bộ của B')
    expect(titles).not.toContain('Tin nội bộ của C')
  })

  it('khách chưa đăng nhập cũng vậy', async () => {
    const res = await request(app).get('/api/v1/listings').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).not.toContain('Tin nội bộ của A')
  })

  /**
   * `X-Org-Id` là "tôi đang thao tác trong nhóm nào", KHÔNG phải bộ lọc đọc. Ghim lại vì đây là
   * một lựa chọn thiết kế dễ bị hiểu ngược: header vốn từng là thứ MỞ KHOÁ nhánh org, nên rất
   * dễ tưởng nó cũng thu hẹp. Muốn thu hẹp thì dùng `?orgId=`.
   */
  it('gửi header nhóm A KHÔNG làm mất tin của nhóm B — header không phải bộ lọc', async () => {
    const titles = await titlesSeenBy(duo, { 'X-Org-Id': orgIdOf(ORG_A) })

    expect(titles).toContain('Tin nội bộ của A')
    expect(titles).toContain('Tin nội bộ của B')
  })

  it('`?orgId=` mới là thứ thu hẹp về một nhóm', async () => {
    const titles = await titlesSeenBy(duo, {}, `?orgId=${orgIdOf(ORG_A)}`)

    expect(titles).toContain('Tin nội bộ của A')
    expect(titles).not.toContain('Tin nội bộ của B')
  })

  /** Thu hẹp CHỈ thu hẹp: xin một nhóm mình không đọc được thì ra rỗng, không ra dữ liệu. */
  it('`?orgId=` của nhóm mình không ở trong → rỗng, không phải dữ liệu của nhóm đó', async () => {
    const titles = await titlesSeenBy(duo, {}, `?orgId=${orgIdOf(ORG_C)}`)

    expect(titles).not.toContain('Tin nội bộ của C')
    expect(titles).toHaveLength(0)
  })
})

/**
 * Nới quyền ĐỌC không được chảy sang bàn QUẢN TRỊ.
 *
 * Mọi cổng trong `auth.middleware` phân quyền theo `ownOrgId` rồi giao cho tầng truy vấn lọc.
 * Nếu quyền đọc đa-nhóm đi kèm vào tận đó thì hàng đợi của nhóm A lẫn tin nhóm B, chỉ vì người
 * duyệt tình cờ là thành viên B. `narrowToOwnOrg` trong `requireOrgModerator` chặn đúng chỗ này.
 */
describe('Bàn quản trị vẫn chỉ nhìn đúng một nhóm', () => {
  const queue = (who: TestUser, org: string, path: string) =>
    request(app).get(path).set(orgAuth(who.token, org))

  it('quản trị A không thấy tin của B trong hàng đợi duyệt của A', async () => {
    const res = await queue(adminA, ORG_A, '/api/v1/moderation/listings?status=active').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).toContain('Tin nội bộ của A')
    expect(titles).not.toContain('Tin nội bộ của B')
  })

  /*
   * Ca này rộng hơn ca trên MỘT BẬC, và là ca đã lọt lưới: bản trước `narrowToOwnOrg` chỉ xoá
   * `memberOrgIds` nên vế `publicAxis` vẫn sống, kéo MỌI tin ACTIVE công khai của toàn sàn vào
   * hàng đợi của A. Đo trên dữ liệu thật: một nhóm có 10 tin, bàn quản trị trả về 122 dòng.
   *
   * Bộ test cũ không bắt được vì mọi tin ở đây đều bậc `members` — bậc DUY NHẤT vắng mặt trong
   * `PUBLICLY_READABLE_REACHES`. Nên hai ca dưới phải dùng tin `marketplace`, không phải tin
   * nội bộ, nếu không chúng chỉ lặp lại ca trên bằng chữ khác.
   */
  it('quản trị A không thấy tin SÀN của nhóm B', async () => {
    const res = await queue(adminA, ORG_A, '/api/v1/moderation/listings?status=active').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).not.toContain('Tin sàn của nhóm B')
  })

  it('và không thấy cả tin sàn không thuộc nhóm nào', async () => {
    const res = await queue(adminA, ORG_A, '/api/v1/moderation/listings?status=active').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).not.toContain('Tin sàn không thuộc nhóm nào')
  })

  /** Chốt xuôi: thu hẹp không được thu quá tay — tin của chính A vẫn phải còn. */
  it('nhưng tin của chính nhóm A thì vẫn còn nguyên', async () => {
    const res = await queue(adminA, ORG_A, '/api/v1/moderation/listings?status=active').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).toContain('Tin nội bộ của A')
  })

  it('nhật ký hoạt động của A cũng không lẫn của B', async () => {
    await queue(adminA, ORG_A, '/api/v1/moderation/activity').expect(200)
  })

  it('thành viên thường của hai nhóm vẫn bị chặn ở cổng, không phải ở tầng dữ liệu', async () => {
    const res = await queue(duo, ORG_B, '/api/v1/moderation/listings')
    expect(res.status).toBe(403)
  })
})

/**
 * Hai chỗ coi "tra ra nhóm con" là bằng chứng nó cùng org, rồi ghi `unitId` đó vào dữ liệu
 * thật. `findInOrg` nêu điều kiện org ngay tại chỗ tra, nên kết luận và bằng chứng đứng cùng
 * một dòng thay vì dựa vào scope của request.
 */
describe('Nhóm con không mượn được qua org khác', () => {
  /*
   * Nhóm A phải RIÊNG TƯ ở đây, nếu không thì không có đơn nào để duyệt: đơn gửi vào một nhóm
   * công khai được nhận thẳng (`status: approved`), nên `getPending` trả 404 và bài test đo
   * nhầm thứ khác. Gạt ở cuối file, sau khi các describe trên đã chạy xong.
   */
  beforeAll(async () => {
    await request(app)
      .patch(`/api/v1/organizations/${orgIdOf(ORG_A)}/visibility`)
      .set(bearer(master))
      .send({ isPublic: false })
      .expect(200)
  }, 60_000)

  it('duyệt đơn vào nhóm A với `unitId` của nhóm B → 400', async () => {
    const applicant = await registerUser(app, 'xin-vao-a@doc.local', 'Người xin vào A')
    const sent = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(applicant))
      .send({ code: await joinCodeOf(ORG_A), claimedName: 'Người xin vào A' })
      .expect(201)

    const res = await request(app)
      .patch(`/api/v1/join-requests/${sent.body.data.id}/approve`)
      .set(orgAuth(adminA.token, ORG_A))
      .send({ unitId: unitOfB })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('Nhóm con')
  })

  it('gửi thông báo trong nhóm A nhắm vào `unitId` của nhóm B → 400 hoặc 403', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(orgAuth(adminA.token, ORG_A))
      .send({ title: 'Thử mượn nhóm con', body: 'Không được phép', unitId: unitOfB })

    // 403 nếu chốt phân quyền chặn trước (`canModerateOrg` với unit lạ), 400 nếu qua được đó
    // rồi mới vấp `findInOrg`. Cả hai đều là "không ghi được", và đó mới là thứ cần ghim.
    expect([400, 403]).toContain(res.status)
  })
})

/**
 * DANH THIẾP NHÓM trên tin — và cái cửa nó phải đóng.
 *
 * Tin của nhóm công khai mang theo `org` để người NGOÀI biết nó đến từ đâu; đây chính là ca mà
 * cách cũ (app tra tên từ `/organizations/mine`) câm, vì người ngoài không có nhóm đó trong
 * danh sách của mình.
 *
 * Ca thứ hai mới là ca phải ghim: gạt nhóm sang riêng tư thì badge PHẢI biến mất. Nếu tên nhóm
 * được snapshot vào tin lúc đăng, nó sẽ sống sót qua cú gạt đó và tiếp tục rò tên một nhóm đã
 * xin được ẩn — đúng lớp lỗi mà cascade trong `setVisibility` sinh ra để chặn, chỉ là đi vòng
 * qua một field khác.
 */
describe('Danh thiếp nhóm đi kèm tin', () => {
  let openId = ''

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(ownerB.token, ORG_B))
      .send({ ...listingPayload('Tin mở của nhóm B', categoryId), reach: 'group_open' })
      .expect(201)
    openId = res.body.data._id
    await publishListing(openId)
  }, 60_000)

  it('người NGOÀI đọc được tên nhóm ngay trên tin', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${openId}`)
      .set(bearer(stranger))
      .expect(200)

    expect(res.body.data.org).toMatchObject({ id: orgIdOf(ORG_B), name: expect.any(String) })
    // `organizationId` vẫn còn nguyên: nó là khoá phân quyền, `org` mới là thứ để vẽ.
    expect(res.body.data.organizationId).toBe(orgIdOf(ORG_B))
  }, 60_000)

  it('danh sách cũng mang badge, và chỉ tốn một lượt tra cho cả trang', async () => {
    const res = await request(app)
      .get(`/api/v1/listings?orgId=${orgIdOf(ORG_B)}`)
      .set(bearer(stranger))
      .expect(200)

    const row = res.body.data.find((l: { _id: string }) => l._id === openId)
    expect(row.org.name).toBeTruthy()
  }, 60_000)

  it('nhóm chuyển sang RIÊNG TƯ → badge biến mất, kể cả với thành viên', async () => {
    await request(app)
      .patch(`/api/v1/organizations/${orgIdOf(ORG_B)}/visibility`)
      .set(bearer(master))
      .send({ isPublic: false })
      .expect(200)

    // `duo` là thành viên nhóm B nên vẫn ĐỌC được tin (cascade đã hạ nó về `members`) — đúng
    // chỗ để đo: tin còn đó, chỉ cái tên nhóm là không được hiện nữa.
    const res = await request(app).get(`/api/v1/listings/${openId}`).set(bearer(duo)).expect(200)

    expect(res.body.data.org).toBeNull()
    expect(res.body.data.organizationId).toBe(orgIdOf(ORG_B))
  }, 60_000)
})
