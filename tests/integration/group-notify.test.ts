import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Thông báo "một thành viên vừa đăng tin" gửi cho CẢ NHÓM.
 *
 * Hai luật khó thấy sai nhất, và là lý do file này tồn tại:
 *
 * 1. **Người đọc thấy thông báo của MỌI nhóm họ tham gia**, không chỉ nhóm đang thao tác. Bản
 *    trước ràng theo `X-Org-Slug` của request, nên người thuộc hai nhóm chỉ đọc được một nửa
 *    hộp thư — và người không gửi header đó (đa số, vì bộ chuyển tổ chức chỉ dành cho master)
 *    không đọc được nhánh phát chung nào cả.
 * 2. **Người đăng KHÔNG nhận thông báo về chính tin của mình.** Nhánh phát chung không có danh
 *    sách người nhận để trừ ai ra, nên việc này phụ thuộc hoàn toàn vào `actorId`.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Ở CẢ hai nhóm — nhân vật chứng minh luật (1). */
let alice: TestUser
/** Chỉ ở nhóm A, và là người đăng tin trong nhóm A. */
let bob: TestUser
/** Chỉ ở nhóm B, để chứng minh nhóm A không rò sang nhóm B. */
let dave: TestUser

let categoryId = ''
const A = 'notify-a'
const B = 'notify-b'

/** Hộp thư KHÔNG gửi `X-Org-Slug` — đúng client của người thuộc nhiều nhóm. */
const inbox = (who: TestUser) =>
  request(app)
    .get('/api/v1/notifications')
    .set({ Authorization: `Bearer ${who.token}` })

const titlesOf = (body: { data: { title: string }[] }) => body.data.map((n) => n.title)

/** Đăng một tin nội bộ vào `slug`. Uy tín mặc định là bậc trần nên tin lên bảng NGAY. */
async function postListing(who: TestUser, slug: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, slug))
    .send({
      title,
      description: 'Hàng dùng kỹ, còn đầy đủ chức năng, ảnh chụp thật.',
      price: 350000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    .expect(201)
  return res.body.data
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const { Category } = await import('../../src/features/category/category.model')
  categoryId = (await Category.create({ name: 'Đồ dùng', slug: 'do-dung' }))._id.toString()

  master = await makeMaster(app)
  const ownerA = await registerUser(app, 'owner@notify-a.local', 'Chủ nhóm A')
  const ownerB = await registerUser(app, 'owner@notify-b.local', 'Chủ nhóm B')

  await createOrg(app, master.token, { name: 'Nhóm A', slug: A, ownerEmail: ownerA.email })
  await createOrg(app, master.token, { name: 'Nhóm B', slug: B, ownerEmail: ownerB.email })

  const orgA = (await import('../../src/features/organization/organization.model')).Organization
  const idA = (await orgA.findOne({ slug: A }))!._id.toString()
  const idB = (await orgA.findOne({ slug: B }))!._id.toString()

  alice = await registerUser(app, 'alice@notify.local', 'Alice')
  await addMember(alice.id, idA)
  await addMember(alice.id, idB)

  bob = await registerUser(app, 'bob@notify.local', 'Bob')
  await addMember(bob.id, idA)

  dave = await registerUser(app, 'dave@notify.local', 'Dave')
  await addMember(dave.id, idB)

  // Bậc trần = tự đăng (`QUOTA.AUTO_APPROVE_TRUST_LEVEL`), nên tin lên bảng ngay và không phải
  // dựng cả luồng duyệt tay chỉ để có một tin `active`.
  for (const u of [alice, bob, dave]) await setTrustLevel(u.id, 2)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Thành viên đăng tin → cả nhóm được báo', () => {
  it('người trong nhóm nhận được, kèm tên người đăng và id tin để bấm vào', async () => {
    const listing = await postListing(bob, A, 'Bàn học gỗ thông')

    const res = await inbox(alice).expect(200)
    const row = res.body.data.find((n: { actorName?: string }) => n.actorName === 'Bob')

    expect(row).toBeDefined()
    expect(row.body).toBe('Bàn học gỗ thông')
    expect(row.listingId).toBe(listing._id)
    expect(row.isRead).toBe(false)
  })

  /*
   * Luật (2). Bob vẫn có đúng MỘT dòng về tin này — dòng đích danh "tin của bạn đã được duyệt"
   * không tồn tại ở nhánh tự-đăng, nên hộp thư của Bob phải trống hẳn về tin đó.
   */
  it('người ĐĂNG không nhận thông báo về tin của chính mình', async () => {
    const res = await inbox(bob).expect(200)
    expect(res.body.data.filter((n: { actorName?: string }) => n.actorName === 'Bob')).toHaveLength(
      0,
    )
  })

  /*
   * Luật (1) — chính lý do của cả thay đổi này. Alice ở cả hai nhóm và KHÔNG gửi `X-Org-Slug`,
   * nên nếu hộp thư còn ràng theo org đang thao tác thì một trong hai dòng phải mất.
   */
  it('người ở HAI nhóm thấy thông báo của cả hai, không cần chọn nhóm đang thao tác', async () => {
    await postListing(dave, B, 'Vợt cầu lông Yonex')

    const titles = titlesOf((await inbox(alice).expect(200)).body)
    expect(titles).toContain('Bob vừa đăng một tin mới')
    expect(titles).toContain('Dave vừa đăng một tin mới')
  })

  it('nhóm A không rò sang người chỉ ở nhóm B', async () => {
    const titles = titlesOf((await inbox(dave).expect(200)).body)
    expect(titles).not.toContain('Bob vừa đăng một tin mới')
  })

  /*
   * Người vào nhóm SAU không nhận cả lịch sử: `createdAt >= joinedAt` ràng theo từng nhóm.
   * Thiếu điều kiện đó thì thành viên mới mở app lần đầu là một hộp thư đầy thông báo của
   * những tin đã cũ hàng tháng.
   */
  it('người vừa vào nhóm KHÔNG nhận thông báo có trước lúc họ vào', async () => {
    const late = await registerUser(app, 'late@notify.local', 'Người vào sau')
    const orgA = (await import('../../src/features/organization/organization.model')).Organization
    await addMember(late.id, (await orgA.findOne({ slug: A }))!._id.toString())

    const titles = titlesOf((await inbox(late).expect(200)).body)
    expect(titles).not.toContain('Bob vừa đăng một tin mới')
  })
})

/*
 * Ranh giới của tính năng: thông báo tin mới là dữ liệu NỘI BỘ của một nhóm. Ai không ở trong
 * nhóm thì không đọc được, bằng MỌI đường — kể cả đường `scope=managed` của bàn quản trị, vốn
 * không đi qua `memberships`.
 */
describe('Ngoài nhóm là không thấy gì', () => {
  it('người không tham gia nhóm nào nhận hộp thư RỖNG, không phải lỗi', async () => {
    const orphan = await registerUser(app, 'orphan@notify.local', 'Không thuộc nhóm nào')

    const res = await inbox(orphan).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  /*
   * Đây là lỗ hổng thật, và nó KHÔNG đi qua `memberships`.
   *
   * `resolveTenant` mở scope đọc của một org cho người NGOÀI nhóm khi request là `GET` (xem
   * `tenant.middleware.ts` — chủ ý, để họ xem được trang công khai của nhóm). Cộng với việc
   * `scope=managed` không đọc `memberships`, một người lạ chỉ cần gửi `X-Org-Slug` của nhóm là
   * đọc được toàn bộ dòng thông báo của nhóm đó.
   */
  it('người ngoài nhóm gửi X-Org-Slug của nhóm cũng KHÔNG đọc được qua scope=managed', async () => {
    const stranger = await registerUser(app, 'stranger@notify.local', 'Người lạ')

    const res = await request(app)
      .get('/api/v1/notifications?scope=managed')
      .set(orgAuth(stranger.token, A))
      .expect(200)

    expect(res.body.data).toHaveLength(0)
  })

  it('thành viên thường cũng không dùng scope=managed để đọc vòng', async () => {
    // Alice là thành viên nhóm A nhưng không có quyền duyệt gì — `managed` phải rỗng.
    const res = await request(app)
      .get('/api/v1/notifications?scope=managed')
      .set(orgAuth(alice.token, A))
      .expect(200)

    expect(res.body.data).toHaveLength(0)
  })

  it('người ĐÃ RỜI nhóm thôi nhận thông báo của nhóm đó', async () => {
    const leaver = await registerUser(app, 'leaver@notify.local', 'Người rời nhóm')
    const { Organization } = await import('../../src/features/organization/organization.model')
    const idA = (await Organization.findOne({ slug: A }))!._id.toString()
    await addMember(leaver.id, idA)

    await postListing(bob, A, 'Tin đăng trước khi rời nhóm')
    expect(titlesOf((await inbox(leaver).expect(200)).body).length).toBeGreaterThan(0)

    // Rời nhóm = membership chuyển `archived`; `listActiveByUser` thôi thấy nó.
    const { Membership } = await import('../../src/features/membership/membership.model')
    await Membership.updateOne(
      { userId: leaver.id, organizationId: idA },
      { $set: { status: 'archived' } },
    )

    expect(
      await inbox(leaver)
        .expect(200)
        .then((r) => r.body.data),
    ).toHaveLength(0)
  })
})

describe('Chỉ báo khi tin THẬT SỰ lên bảng', () => {
  it('tin trên trục danh mục không báo cho nhóm nào', async () => {
    const before = titlesOf((await inbox(alice).expect(200)).body).length

    await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${bob.token}` })
      .send({
        title: 'Ghế xếp dã ngoại',
        description: 'Ghế gấp gọn, dùng vài lần, còn chắc chắn.',
        price: 180000,
        categoryId,
        visibility: 'public',
        images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
        location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      })
      .expect(201)

    // Tin công khai không thuộc bảng tin nhóm nào — không có nhóm nào để báo.
    expect(titlesOf((await inbox(alice).expect(200)).body)).toHaveLength(before)
  })

  it('tin CHỜ DUYỆT chưa báo cho ai — báo sớm là mời cả nhóm bấm vào một trang không mở được', async () => {
    // Hạ bậc uy tín để tin rơi vào hàng đợi thay vì tự đăng.
    await setTrustLevel(bob.id, 0)
    const before = titlesOf((await inbox(alice).expect(200)).body).length

    await postListing(bob, A, 'Tin phải chờ duyệt')
    expect(titlesOf((await inbox(alice).expect(200)).body)).toHaveLength(before)

    await setTrustLevel(bob.id, 2)
  })
})

describe('Trạng thái đọc đi bằng mốc thời gian, không phải mảng `readBy`', () => {
  it('đánh dấu đã đọc một dòng thì các dòng CŨ HƠN cùng nhóm cũng thành đã đọc', async () => {
    // Hai tin trong cùng nhóm A → hai dòng, dòng thứ hai mới hơn.
    await postListing(bob, A, 'Tin thứ nhất trong nhóm A')
    await postListing(bob, A, 'Tin thứ hai trong nhóm A')

    const rows = (await inbox(alice).expect(200)).body.data.filter(
      (n: { actorName?: string; organizationId: string | null }) => n.actorName === 'Bob',
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)

    // `sort({ createdAt: -1 })` nên phần tử đầu là mới nhất.
    const newest = rows[0]
    await request(app)
      .patch(`/api/v1/notifications/${newest.id}/read`)
      .set({ Authorization: `Bearer ${alice.token}` })
      .expect(200)

    /*
     * Mốc `notificationsSeenAt` của nhóm A nay bằng `createdAt` của dòng mới nhất, nên MỌI dòng
     * của nhóm A đều đã đọc. Đây là hệ quả có chủ ý của cơ chế mốc — và cũng là điều `readBy`
     * không làm được mà không ghi một id cho mỗi người mỗi dòng.
     */
    const after = (await inbox(alice).expect(200)).body.data.filter(
      (n: { actorName?: string }) => n.actorName === 'Bob',
    )
    expect(after.every((n: { isRead: boolean }) => n.isRead)).toBe(true)
  })

  it('nhưng nhóm KHÁC vẫn còn chưa đọc — mốc là của từng nhóm, không phải một mốc chung', async () => {
    const rows = (await inbox(alice).expect(200)).body.data.filter(
      (n: { actorName?: string }) => n.actorName === 'Dave',
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((n: { isRead: boolean }) => !n.isRead)).toBe(true)
  })
})
