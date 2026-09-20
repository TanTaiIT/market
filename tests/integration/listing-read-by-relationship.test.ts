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
  listingPayload,
  makeMaster,
  orgAuth,
  publishListing,
  registerUser,
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * Đọc MỘT tin theo id: quyền theo QUAN HỆ, không theo `X-Org-Id`.
 *
 * Lỗi thật đã gặp: thành viên của HAI nhóm mở tin nội bộ của nhóm A từ hồ sơ nhóm — danh sách
 * tải được (lượt gọi đó gắn header nhóm A), bấm vào chi tiết thì 404 (lượt gọi đó dùng header
 * "org đang thao tác", đang trỏ nhóm B hoặc rỗng). Cùng lỗ này cắn cả "Nhắn tin" và "Lưu tin".
 *
 * Nhân vật chính của file là `dual` — người thuộc cả A và B. `ownerA` thuộc đúng một nhóm nên
 * bản cũ tình cờ vẫn chạy nhờ fallback "tự suy org khi chỉ có một membership"; test của họ ở
 * đây là để chốt fallback biến mất cũng không ai hỏng.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let ownerA: TestUser
let ownerB: TestUser
/** Thành viên CẢ HAI nhóm — ca làm lộ lỗi. */
let dual: TestUser

const A = 'nhom-a'
const B = 'nhom-b'
const HCM = 'Hồ Chí Minh'

let internalId = ''
let pendingInternalId = ''
let publicId = ''

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const detail = (id: string) => request(app).get(`/api/v1/listings/${id}`)

async function postAsOwnerA(title: string, reach: 'members' | 'marketplace', publish = true) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(ownerA.token, A))
    .send({ ...listingPayload(title, categoryId), reach, provinceCode: HCM })
    .expect(201)
  if (publish) await publishListing(res.body.data._id)
  return res.body.data._id as string
}

let categoryId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner-a@quan-he.local', 'Chủ nhóm A')
  ownerB = await registerUser(app, 'owner-b@quan-he.local', 'Chủ nhóm B')
  dual = await registerUser(app, 'hai-nhom@quan-he.local', 'Người hai nhóm')

  const orgA = await createOrg(app, master.token, {
    name: 'Nhóm A',
    key: A,
    ownerEmail: ownerA.email,
    provinceCode: HCM,
  })
  const orgB = await createOrg(app, master.token, {
    name: 'Nhóm B',
    key: B,
    ownerEmail: ownerB.email,
    provinceCode: HCM,
  })
  await addMember(dual.id, orgA.id)
  await addMember(dual.id, orgB.id)

  categoryId = await createCategory()

  internalId = await postAsOwnerA('Bàn học nội bộ nhóm A', 'members')
  publicId = await postAsOwnerA('Đèn bàn công khai', 'marketplace')

  /*
   * Tin CHƯA PUBLIC: ép `pending` tường minh, KHÔNG suy từ "chưa gọi publishListing".
   *
   * Chủ nhóm đăng vào nhóm mình được tự duyệt ngay (ra `active`), nên bản đầu của fixture này
   * — bỏ publish rồi mong nó pending — cho ra một tin đang public, và test "chưa duyệt → 404"
   * đỏ vì lý do không liên quan gì tới điều nó muốn chốt. Ép trạng thái ở tầng model, cùng cách
   * `publishListing` làm theo chiều ngược lại.
   */
  pendingInternalId = await postAsOwnerA('Ghế nội bộ chưa duyệt', 'members', false)
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const { LISTING_STATUS } = await import('../../src/common/constants')
  await runUnscoped('test fixture: ép tin về pending', () =>
    Listing.updateOne({ _id: pendingInternalId }, { status: LISTING_STATUS.PENDING }).exec(),
  )
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Thành viên HAI nhóm mở tin nội bộ của nhóm A', () => {
  it('đang đứng ở nhóm B (X-Org-Id: nhom-b) vẫn đọc được — đây là lỗi đã gặp', async () => {
    const res = await detail(internalId).set(orgAuth(dual.token, B)).expect(200)
    expect(res.body.data._id).toBe(internalId)
  })

  it('không gửi header nào cũng đọc được — hai membership nên BE không tự suy được org', async () => {
    const res = await detail(internalId).set(bearer(dual)).expect(200)
    expect(res.body.data._id).toBe(internalId)
  })
})

describe('Thành viên MỘT nhóm — fallback cũ biến mất cũng không hỏng', () => {
  it('không header → 200', async () => {
    await detail(internalId).set(bearer(ownerA)).expect(200)
  })

  it('đúng header nhóm mình → 200', async () => {
    await detail(internalId).set(orgAuth(ownerA.token, A)).expect(200)
  })
})

describe('Người ngoài và khách — 404, không phải 403', () => {
  /*
   * 404 là ranh giới tenant: 403 xác nhận "id này có tồn tại" cho người ngoài nhóm, đủ để
   * quét id lập danh sách tin nội bộ của tổ chức khác (convention §8).
   */
  it('thành viên nhóm B gửi đúng id nhóm A → 404: header không phải vé vào', async () => {
    await detail(internalId).set(orgAuth(ownerB.token, A)).expect(404)
  })

  it('thành viên nhóm B không header → 404', async () => {
    await detail(internalId).set(bearer(ownerB)).expect(404)
  })

  it('khách → 404, kể cả khi gửi id nhóm A', async () => {
    await detail(internalId).expect(404)
    await detail(internalId)
      .set({ 'X-Org-Id': orgIdOf(A) })
      .expect(404)
  })
})

describe('Trạng thái và trục', () => {
  it('tin nội bộ CHƯA duyệt → 404 ngay cả với chính chủ đọc qua đường thường', async () => {
    // Tin chờ duyệt đọc qua `getForModeration`, không qua màn chi tiết — y như `incrementView` cũ.
    await detail(pendingInternalId).set(orgAuth(ownerA.token, A)).expect(404)
  })

  it('tin CÔNG KHAI đã duyệt: khách đọc được — trục công khai không bị siết theo', async () => {
    const res = await detail(publicId).expect(200)
    expect(res.body.data._id).toBe(publicId)
  })

  it('master KHÔNG phải thành viên vẫn đọc tin nội bộ — bàn duyệt của họ vốn liệt kê nó', async () => {
    await detail(internalId).set(bearer(master)).expect(200)
  })
})

describe('Lượt xem', () => {
  it('cộng đúng một sau mỗi lượt đọc hợp lệ', async () => {
    const first = await detail(internalId).set(orgAuth(dual.token, B)).expect(200)
    const second = await detail(internalId).set(orgAuth(dual.token, B)).expect(200)
    expect(second.body.data.viewCount).toBe(first.body.data.viewCount + 1)
  })

  it('KHÔNG cộng vì một lượt 404', async () => {
    const before = await detail(internalId).set(bearer(dual)).expect(200)
    await detail(internalId).set(bearer(ownerB)).expect(404)
    const after = await detail(internalId).set(bearer(dual)).expect(200)
    // `after` tự cộng 1 cho lượt của nó; lượt 404 ở giữa không được cộng thêm gì.
    expect(after.body.data.viewCount).toBe(before.body.data.viewCount + 1)
  })
})

describe('Nhắn tin và Lưu tin đi cùng một chốt', () => {
  it('thành viên hai nhóm đứng ở B vẫn mở được chat cho tin nội bộ của A', async () => {
    await request(app)
      .post('/api/v1/chats')
      .set(orgAuth(dual.token, B))
      .send({ listingId: internalId })
      .expect(201)
  })

  it('… và lưu được tin đó', async () => {
    const res = await request(app)
      .post(`/api/v1/favorites/${internalId}`)
      .set(orgAuth(dual.token, B))
    expect(res.status).toBeLessThan(300)
  })

  it('người ngoài lưu tin nội bộ → 404, dù gửi đúng id', async () => {
    await request(app)
      .post(`/api/v1/favorites/${internalId}`)
      .set(orgAuth(ownerB.token, A))
      .expect(404)
  })
})
