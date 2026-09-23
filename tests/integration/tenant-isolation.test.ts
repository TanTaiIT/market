import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  PASSWORD,
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  publishListing,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let CATEGORY_ID = ''
let master: TestUser
const orgA = { id: '', key: 'org-a', owner: {} as TestUser, listingId: '' }
const orgB = { id: '', key: 'org-b', owner: {} as TestUser, listingId: '' }

/**
 * `reach: 'members'` khai TƯỜNG MINH, không để mặc định.
 *
 * Cả file này đo sự cách ly NỘI DUNG TRONG NHÓM, mà mặc định của một nhóm công khai (và org
 * trong fixture công khai, vì `isPublic` mặc định `true`) nay là `group_open` — bậc mà người
 * ngoài ĐỌC ĐƯỢC. Để mặc định thì mọi ca dưới đây đo nhầm một thứ khác và đỏ vì đúng lý do sai.
 */
async function createListing(user: TestUser, org: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(user.token, org))
    .send({ ...listingPayload(title, CATEGORY_ID), reach: 'members' })
    .expect(201)
  return res.body.data._id as string
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  CATEGORY_ID = await createCategory()
  master = await makeMaster(app)

  orgA.owner = await registerUser(app, 'owner@org-a.local', 'Owner A')
  orgB.owner = await registerUser(app, 'owner@org-b.local', 'Owner B')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(orgA.owner.id, 0)
  await setTrustLevel(orgB.owner.id, 0)

  orgA.id = (
    await createOrg(app, master.token, {
      name: 'Org A',
      key: orgA.key,
      ownerEmail: orgA.owner.email,
    })
  ).id
  orgB.id = (
    await createOrg(app, master.token, {
      name: 'Org B',
      key: orgB.key,
      ownerEmail: orgB.owner.email,
    })
  ).id

  orgA.listingId = await createListing(orgA.owner, orgA.key, 'Tin đăng của org A')
  orgB.listingId = await createListing(orgB.owner, orgB.key, 'Tin đăng của org B')
  await publishListing(orgA.listingId)
  await publishListing(orgB.listingId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Cách ly giữa hai org', () => {
  it('GET /listings chỉ trả tin của org đang hoạt động', async () => {
    const res = await request(app).get('/api/v1/listings').set(orgAuth(orgA.owner.token, orgA.key))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]._id).toBe(orgA.listingId)
  })

  it('đọc tin org khác trả 404 chứ không phải 403 — không lộ sự tồn tại', async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.key))
    expect(res.status).toBe(404)
  })

  it('sửa và xoá tin org khác cũng trả 404', async () => {
    const patched = await request(app)
      .patch(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.key))
      .send({ price: 1 })
    expect(patched.status).toBe(404)

    const deleted = await request(app)
      .delete(`/api/v1/listings/${orgB.listingId}`)
      .set(orgAuth(orgA.owner.token, orgA.key))
    expect(deleted.status).toBe(404)
  })

  it('ghi tin mới luôn rơi vào org đang hoạt động', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(orgA.owner.token, orgA.key))
      .send(listingPayload('Tin mới của org A', CATEGORY_ID))

    expect(res.status).toBe(201)
    expect(res.body.data.organizationId).toBe(orgA.id)
  })
})

describe('Org hoạt động đến từ request, không từ token', () => {
  /**
   * Bài này TỪNG ghim điều ngược lại — "chỉ ra org nào thì thấy dữ liệu org đó" — và đó chính
   * là thứ vừa được bỏ: người thuộc hai nhóm phải chọn "nhóm đang thao tác" mới thấy tin, chưa
   * chọn thì không thấy tin nội bộ nào cả.
   *
   * Từ nay `X-Org-Id` chỉ còn nghĩa "tôi đang THAO TÁC trong nhóm nào" — nó quyết định chỗ GHI
   * và phạm vi bàn quản trị, không cắt bớt thứ mình ĐỌC ĐƯỢC. Thu hẹp khi đọc là việc của
   * `?orgId=`, thứ duy nhất phục vụ được cả người ngoài (xem `multi-org-read.test.ts`).
   */
  it('một tài khoản thuộc HAI org thấy dữ liệu của CẢ HAI, không cần chỉ ra org nào', async () => {
    const nomad = await registerUser(app, 'nomad@example.com', 'Người hai nơi')
    await addMember(nomad.id, orgA.id)
    await addMember(nomad.id, orgB.id)

    const seen = await request(app)
      .get('/api/v1/listings')
      .set({ Authorization: `Bearer ${nomad.token}` })
      .expect(200)
    const ids = seen.body.data.map((l: { _id: string }) => l._id)

    expect(ids).toContain(orgA.listingId)
    expect(ids).toContain(orgB.listingId)
  })

  it('và gửi header một org cũng KHÔNG cắt bớt org kia — header không phải bộ lọc đọc', async () => {
    const nomad = await registerUser(app, 'nomad2@example.com', 'Người hai nơi nữa')
    await addMember(nomad.id, orgA.id)
    await addMember(nomad.id, orgB.id)

    const inA = await request(app)
      .get('/api/v1/listings')
      .set(orgAuth(nomad.token, orgA.key))
      .expect(200)
    const ids = inA.body.data.map((l: { _id: string }) => l._id)

    expect(ids).toContain(orgA.listingId)
    expect(ids).toContain(orgB.listingId)
  })

  it('`?orgId=` thì mới thu hẹp về đúng một org', async () => {
    const nomad = await registerUser(app, 'nomad3@example.com', 'Người hai nơi ba')
    await addMember(nomad.id, orgA.id)
    await addMember(nomad.id, orgB.id)

    const inA = await request(app)
      .get(`/api/v1/listings?orgId=${orgA.id}`)
      .set({ Authorization: `Bearer ${nomad.token}` })
      .expect(200)
    const ids = inA.body.data.map((l: { _id: string }) => l._id)

    expect(ids).toContain(orgA.listingId)
    expect(ids).not.toContain(orgB.listingId)
  })

  /**
   * Bài này TỪNG khẳng định 400. Nó đúng khi mặc định là `org_internal`: không có scope thì
   * không có org, mà tin nội bộ bắt buộc có org, nên `routeListing` chặn.
   *
   * Mặc định nay là `defaultReachFor` — không nhóm nào thì `marketplace`, và đăng tin lên SÀN
   * thì vốn không đòi ai phải là thành viên của gì. Nên 201 là đúng, và bất biến thật cần ghim
   * không phải mã lỗi mà là: **tin KHÔNG lọt vào org A**. Header của một nhóm mình không thuộc
   * về không mở scope nào, nên `organizationId` phải là `null`.
   */
  it('không thuộc org thì tin KHÔNG mang tên org đó', async () => {
    const outsider = await registerUser(app, 'outsider@example.com', 'Người ngoài')

    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(outsider.token, orgA.key))
      .send(listingPayload('Tin của người ngoài', CATEGORY_ID))
      .expect(201)

    expect(res.body.data.organizationId).toBeNull()
    expect(res.body.data.reach).toBe('marketplace')
  })

  /** Muốn ghi VÀO nhóm thì phải nêu tên nhóm — và lúc đó chốt người-ngoài mới lên tiếng. */
  it('và nêu đích danh nhóm thì rơi vào hàng đợi người-ngoài, không vào thẳng', async () => {
    const outsider = await registerUser(app, 'outsider2@example.com', 'Người ngoài nữa')

    const res = await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${outsider.token}` })
      .send({ ...listingPayload('Tin gửi vào nhóm A', CATEGORY_ID), orgId: orgA.id })
      .expect(201)

    expect(res.body.data.organizationId).toBe(orgA.id)
    expect(res.body.data.status).toBe('pending_unverified')
  })

  it('rời org là mất quyền NGAY, không đợi token hết hạn', async () => {
    const leaver = await registerUser(app, 'leaver@example.com', 'Người rời đi')
    await addMember(leaver.id, orgA.id)

    const before = await request(app).get('/api/v1/listings').set(orgAuth(leaver.token, orgA.key))
    expect(before.status).toBe(200)

    const { Membership } = await import('../../src/features/membership/membership.model')
    await Membership.updateOne(
      { userId: leaver.id, organizationId: orgA.id },
      { status: 'archived' },
    ).exec()

    /*
     * Cùng token đó, tin không còn mang tên org nữa.
     *
     * Trước đây ca này đo bằng 400 (mặc định `org_internal` + không có org = chặn). Mặc định
     * nay đưa tin lên sàn, nên thứ cần ghim là scope đã ĐÓNG: `organizationId` null, chứ không
     * phải một mã lỗi vốn chỉ là tác dụng phụ của mặc định cũ.
     */
    const after = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(leaver.token, orgA.key))
      .send(listingPayload('Tin sau khi rời org', CATEGORY_ID))
      .expect(201)
    expect(after.body.data.organizationId).toBeNull()
  })
})

describe('Nhánh master', () => {
  it('user thường KHÔNG tạo được org', async () => {
    const res = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${orgA.owner.token}`)
      .send({ name: 'Org tự tạo', ownerEmail: orgA.owner.email })
    expect(res.status).toBe(403)
  })

  it('chủ org nhận được quyền manager scope org của mình', async () => {
    const res = await request(app)
      .get('/api/v1/role-grants/mine')
      .set('Authorization', `Bearer ${orgA.owner.token}`)
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ role: 'manager', scopeType: 'org', orgId: orgA.id })
  })

  it('suspend organization có hiệu lực ngay', async () => {
    const suspended = await request(app)
      .patch(`/api/v1/organizations/${orgB.id}/status`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ status: 'suspended' })
    expect(suspended.status).toBe(200)

    const res = await request(app).get('/api/v1/listings').set(orgAuth(orgB.owner.token, orgB.key))
    expect(res.status).toBe(403)
  })

  /**
   * Ca đã đẩy người dùng ra khỏi app: client gắn `X-Org-Id` vào MỌI request, nên org đang chọn
   * bị khoá làm chết luôn `/auth/refresh` — đúng cái lối dùng để tự cứu phiên. App thấy refresh
   * hỏng thì dọn phiên, và người dùng bị đăng xuất vì một lý do không liên quan gì tới phiên của
   * họ; đăng nhập lại thì client tự chọn lại đúng org đó và vòng lặp khép kín.
   *
   * Đường phiên vì thế được miễn tenant scope (`SESSION_PATH` trong `tenant.middleware`).
   */
  it('org bị khoá KHÔNG làm chết đường đăng nhập / refresh phiên', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set(orgAuth(orgB.owner.token, orgB.key))
      .send({ email: orgB.owner.email, password: PASSWORD })

    expect(login.status).toBe(200)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set(orgAuth(orgB.owner.token, orgB.key))
      .send({ refreshToken: login.body.data.tokens.refreshToken })

    expect(refreshed.status).toBe(200)
  })

  /**
   * `findByIds` cố ý giữ org bị khoá trong danh sách để người gọi phân biệt "khoá" với "không
   * còn" — lời hứa đó chỉ thành thật khi DTO nói ra trạng thái. Thiếu nó, client tự chọn org
   * duy nhất mình thuộc về mà không biết nó đã khoá.
   */
  it('/organizations/mine nói ra org đang bị khoá', async () => {
    const res = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${orgB.owner.token}`)
      .expect(200)

    const row = res.body.data.find((o: { id: string }) => o.id === orgB.id)
    expect(row).toMatchObject({ status: 'suspended' })
  })

  it('không thu hồi được master cuối cùng', async () => {
    const grants = await request(app)
      .get('/api/v1/role-grants/mine')
      .set('Authorization', `Bearer ${master.token}`)
      .expect(200)

    const masterGrantId = grants.body.data[0].id
    // Tự thu hồi quyền của chính mình đã bị chặn từ tầng policy.
    const res = await request(app)
      .delete(`/api/v1/role-grants/${masterGrantId}`)
      .set('Authorization', `Bearer ${master.token}`)
    expect(res.status).toBe(403)
  })
})

describe('Đăng nhập không còn phụ thuộc org', () => {
  it('cùng email không thể tồn tại ở hai org nữa — tài khoản là toàn cục', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Trùng', email: orgA.owner.email, password: PASSWORD })
    expect(res.status).toBe(409)
  })
})
