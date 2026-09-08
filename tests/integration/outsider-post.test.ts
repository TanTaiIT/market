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
  makeMaster,
  orgAuth,
  registerUser,
  setTrustLevel,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Thành viên của org A — nhân vật chính: họ phải đăng được vào org B với tư cách người ngoài. */
let memberOfA: TestUser
/** Không thuộc org nào. */
let loner: TestUser
let ownerB: TestUser
/** Thành viên của CẢ A và B — ca mà `resolveTenant` không suy ra được org nào. */
let duoMember: TestUser
/** Cũng hai nhóm, nhưng GIỮ bậc trần — tin tự lên `active` và kéo theo lượt báo cả nhóm. */
let duoTrusted: TestUser
let categoryId = ''

const SLUG_A = 'nhom-a'
const SLUG_B = 'nhom-b'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  memberOfA = await registerUser(app, 'member-a@outsider.local', 'Thành viên nhóm A')
  ownerB = await registerUser(app, 'owner-b@outsider.local', 'Chủ nhóm B')
  loner = await registerUser(app, 'loner@outsider.local', 'Người không nhóm')
  duoMember = await registerUser(app, 'duo@outsider.local', 'Người hai nhóm')
  duoTrusted = await registerUser(app, 'duo-trusted@outsider.local', 'Người hai nhóm bậc trần')
  // Mặc định giờ là BẬC TRẦN (`INITIAL_TRUST`) — tài khoản mới tự đăng thẳng lên bảng. Hạ bậc
  // người bán để tin rơi vào hàng đợi, đúng tình huống các ca dưới đây mô tả.
  await setTrustLevel(memberOfA.id, 0)
  await setTrustLevel(loner.id, 0)

  await createOrg(app, master.token, { name: 'Nhóm A', slug: SLUG_A, ownerEmail: memberOfA.email })
  await createOrg(app, master.token, { name: 'Nhóm B', slug: SLUG_B, ownerEmail: ownerB.email })

  await setTrustLevel(duoMember.id, 0)
  await addMember(duoMember.id, await orgIdOf(SLUG_A))
  await addMember(duoMember.id, await orgIdOf(SLUG_B))
  await addMember(duoTrusted.id, await orgIdOf(SLUG_A))
  await addMember(duoTrusted.id, await orgIdOf(SLUG_B))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

/** Cố tình KHÔNG gửi `X-Org-Slug`: đúng cách client thật gọi khi người dùng chọn nhóm trong form. */
function post(who: TestUser, body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/listings')
    .set({ Authorization: `Bearer ${who.token}` })
    .send({
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      ...body,
    })
}

async function readListing(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đọc tin', () =>
    Listing.findById(id).select('status organizationId visibility').lean().exec(),
  )
}

async function orgIdOf(slug: string) {
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findOne({ slug }).lean().exec()
  return org!._id.toString()
}

describe('Người ngoài đăng tin vào nhóm', () => {
  it('người không thuộc nhóm nào gửi tin vào nhóm B → vào hàng đợi người-ngoài của B', async () => {
    const res = await post(loner, {
      title: 'Tin của người ngoài gửi vào nhóm B',
      orgSlug: SLUG_B,
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.status).toBe('pending_unverified')
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))
  }, 60_000)

  /**
   * Ca đã im lặng đi sai trước khi sửa: `resolveTenant` tự chọn org A vì người này chỉ thuộc
   * đúng một nhóm, và bản cũ để `isMember` thắng `orgSlug` → tin rơi vào A thay vì B.
   */
  it('thành viên nhóm A gửi tin sang nhóm B → tin phải vào B, KHÔNG rơi về A', async () => {
    const res = await post(memberOfA, {
      title: 'Thành viên A gửi sang nhóm B',
      orgSlug: SLUG_B,
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))
    expect(doc?.organizationId?.toString()).not.toBe(await orgIdOf(SLUG_A))
    // Là người ngoài với B nên đi hàng đợi chưa xác minh, dù họ là thành viên ở nơi khác.
    expect(doc?.status).toBe('pending_unverified')
  }, 60_000)

  it('gửi vào chính nhóm của mình vẫn là thành viên — hàng đợi thường, không phải người-ngoài', async () => {
    const res = await post(memberOfA, {
      title: 'Thành viên A đăng vào chính nhóm A',
      orgSlug: SLUG_A,
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_A))
    expect(doc?.status).toBe('pending')
  }, 60_000)

  it('quản trị nhóm B thấy và duyệt được tin người ngoài', async () => {
    const created = await post(loner, { title: 'Tin chờ nhóm B duyệt', orgSlug: SLUG_B }).expect(
      201,
    )

    const queue = await request(app)
      .get('/api/v1/moderation/listings?status=pending_unverified')
      .set(orgAuth(ownerB.token, SLUG_B))
      .expect(200)
    expect(queue.body.data.map((l: { _id: string }) => l._id)).toContain(created.body.data._id)

    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(orgAuth(ownerB.token, SLUG_B))
      .send({ status: 'active' })
      .expect(200)

    expect((await readListing(created.body.data._id))?.status).toBe('active')
  }, 60_000)
})

describe('Nhóm kín tự đóng cửa được', () => {
  it('admin nhóm B tắt setting → người ngoài bị từ chối; bật lại thì gửi được', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(ownerB.token, SLUG_B))
      .send({ allowOutsiderPosts: false })
      .expect(200)

    const blocked = await post(loner, { title: 'Tin gửi vào nhóm đã đóng', orgSlug: SLUG_B })
    expect(blocked.status).toBe(400)
    expect(blocked.body.message).toContain('người ngoài')

    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(ownerB.token, SLUG_B))
      .send({ allowOutsiderPosts: true })
      .expect(200)

    await post(loner, { title: 'Tin gửi sau khi mở lại' }).expect(400) // thiếu orgSlug → tin nội bộ không có org
    await post(loner, { title: 'Tin gửi sau khi mở lại nhóm', orgSlug: SLUG_B }).expect(201)
  }, 60_000)
})

describe('Tin người ngoài chỉ sống trong nhóm', () => {
  it('không mượn được tên nhóm chưa tham gia để lên bảng công khai', async () => {
    const res = await post(loner, {
      title: 'Tin công khai mượn danh nhóm B',
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
      orgSlug: SLUG_B,
    })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('chưa tham gia')
  }, 60_000)

  it('tin công khai KHÔNG kèm nhóm thì vẫn đăng bình thường', async () => {
    const res = await post(loner, {
      title: 'Tin công khai không dính nhóm nào',
      visibility: 'public',
      provinceCode: 'Hồ Chí Minh',
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.visibility).toBe('public')
    expect(doc?.organizationId).toBeNull()
  }, 60_000)
})

/**
 * Ca THÀNH VIÊN của `orgSlug`, đứng cạnh các ca người-ngoài ở trên vì cùng một trục: tin đi
 * vào nhóm nào do BODY chỉ ra, còn tenant scope thì do HEADER quyết — hai nguồn có thể lệch.
 *
 * Ba test ở trên đều lệch mà vẫn xanh nhờ một sự trùng hợp: người đăng thuộc ĐÚNG MỘT nhóm, nên
 * `resolveTenant` tự suy ra org đó; hoặc họ là người ngoài, nên lượt ghi đi nhánh `runUnscoped`.
 * Người thuộc HAI nhóm rơi ra ngoài cả hai lối đó.
 */
describe('Thành viên nhiều nhóm đăng tin qua orgSlug', () => {
  it('không gửi header org → tin vào đúng nhóm chỉ trong body', async () => {
    const res = await post(duoMember, {
      title: 'Người hai nhóm đăng vào nhóm B',
      orgSlug: SLUG_B,
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))
    // Là THÀNH VIÊN của B nên hàng đợi thường, không phải hàng đợi chưa xác minh.
    expect(doc?.status).toBe('pending')
  }, 60_000)

  it('header trỏ nhóm A, body chỉ nhóm B → body thắng, không rơi về A', async () => {
    const res = await post(duoMember, {
      title: 'Đang đứng ở A nhưng đăng vào B',
      orgSlug: SLUG_B,
    })
      .set('X-Org-Slug', SLUG_A)
      .expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))
    expect(doc?.status).toBe('pending')
  }, 60_000)

  /**
   * Đúng ca người dùng thật gặp: tài khoản seed ở bậc trần nên tin tự lên `active`, và ngay sau
   * lượt ghi là `notifyGroupOfListing`. Test hai ca trên hạ bậc xuống 0 nên dừng ở `pending` —
   * chúng không đi qua nhánh này.
   */
  it('bậc trần → tin tự lên active và cả nhóm nhận được thông báo', async () => {
    const res = await post(duoTrusted, {
      title: 'Người hai nhóm bậc trần đăng vào nhóm B',
      orgSlug: SLUG_B,
    }).expect(201)

    const doc = await readListing(res.body.data._id)
    expect(doc?.status).toBe('active')
    expect(doc?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))

    // Thông báo phải nằm dưới nhóm B — nhóm SỞ HỮU tin, không phải nhóm A mà header hay trỏ tới.
    const { Notification } = await import('../../src/features/notification/notification.model')
    const notif = await Notification.findOne({ listingId: res.body.data._id }).lean().exec()
    expect(notif?.organizationId?.toString()).toBe(await orgIdOf(SLUG_B))
    expect(notif?.userId).toBeNull()
  }, 60_000)
})
