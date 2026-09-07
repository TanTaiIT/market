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
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * AI ĐỌC ĐƯỢC tin nào — vế còn thiếu của bộ test hai trục.
 *
 * `two-axis.test.ts` đã chốt tin đi vào HÀNG ĐỢI nào. File này chốt thứ khác: sau khi duyệt
 * xong, tin hiện ra với ai. Hai câu hỏi khác nhau, và câu thứ hai mới là thứ người dùng nhìn
 * thấy — một tin nội bộ lọt ra trang công khai là sự cố, không phải lỗi định tuyến.
 *
 * Ba ca phủ hết bảng định tuyến (`listing.routing.ts`):
 * | organizationId | visibility   | thành viên org | người ngoài |
 * |----------------|--------------|----------------|-------------|
 * | có             | org_internal | thấy           | KHÔNG thấy  |
 * | có             | public       | thấy           | thấy        |
 * | null           | public       | thấy           | thấy        |
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let member: TestUser
let outsider: TestUser
let categoryId = ''

const SLUG = 'truong-hai-truc'
const HCM = 'Hồ Chí Minh'
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

/** Tin của thành viên org. `visibility` là thứ DUY NHẤT khác nhau giữa hai ca đầu. */
async function postAsMember(title: string, visibility: 'org_internal' | 'public') {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(member.token, SLUG))
    .send({ ...listingPayload(title, categoryId), visibility, provinceCode: HCM })
    .expect(201)
  await publishListing(res.body.data._id)
  return res.body.data._id as string
}

const titlesSeenBy = async (u: TestUser, headers: Record<string, string> = {}) => {
  const res = await request(app)
    .get('/api/v1/listings')
    .set({ ...bearer(u), ...headers })
    .expect(200)
  return res.body.data.map((l: { title: string }) => l.title)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Việc làm', 'viec-lam')
  master = await makeMaster(app)
  member = await registerUser(app, 'thanh-vien@truong.local', 'Thành viên')
  outsider = await registerUser(app, 'nguoi-ngoai@example.com', 'Người ngoài')

  await createOrg(app, master.token, {
    name: 'Trường Hai Trục',
    slug: SLUG,
    ownerEmail: member.email,
    provinceCode: HCM,
  })

  await postAsMember('Tin NỘI BỘ của trường', 'org_internal')
  await postAsMember('Tin CÔNG KHAI từ trường', 'public')

  // Người không thuộc org nào: tin bắt buộc phải là công khai, và `organizationId` là null.
  const lone = await request(app)
    .post('/api/v1/listings')
    .set(bearer(outsider))
    .send({
      ...listingPayload('Tin CÔNG KHAI không thuộc trường nào', categoryId),
      visibility: 'public',
      provinceCode: HCM,
    })
    .expect(201)
  await publishListing(lone.body.data._id)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Người NGOÀI org đọc được gì', () => {
  /**
   * Câu trả lời cho "tin đăng ở org có hiện ra ngoài org không": KHÔNG, trừ khi người đăng chủ
   * động chọn `public`. Mặc định của model là `org_internal` nên im lặng là ở lại trong trường.
   */
  it('KHÔNG thấy tin nội bộ của trường', async () => {
    const titles = await titlesSeenBy(outsider)
    expect(titles).not.toContain('Tin NỘI BỘ của trường')
  })

  it('CÓ thấy tin công khai, kể cả tin do người trong trường đăng', async () => {
    const titles = await titlesSeenBy(outsider)
    expect(titles).toContain('Tin CÔNG KHAI từ trường')
    expect(titles).toContain('Tin CÔNG KHAI không thuộc trường nào')
  })

  it('khách CHƯA đăng nhập cũng chỉ thấy đúng hai tin công khai đó', async () => {
    const res = await request(app).get('/api/v1/listings').expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).not.toContain('Tin NỘI BỘ của trường')
    expect(titles).toContain('Tin CÔNG KHAI từ trường')
  })
})

/*
 * Lỗ hổng mà cả file này SUÝT bỏ qua: mọi assertion phía trên gọi `GET /listings` mà KHÔNG gửi
 * `X-Org-Slug`, nên chúng chỉ chứng minh scope mặc định là đúng.
 *
 * Gửi header đó là một chuyện khác hẳn: `resolveTenant` từng cấp `readableOrgIds: [org]` cho
 * cả khách không token lẫn người ngoài trên request `GET`, tức nhánh org của `tenantPlugin` mở
 * ra và tin `org_internal` chảy về cho người chỉ cần BIẾT SLUG — mà slug nằm trong mọi link
 * chia sẻ. Đo trên dữ liệu thật trước khi sửa: 4/50 tin trả về là tin nội bộ.
 */
describe('Gửi X-Org-Slug KHÔNG mở được nhánh org cho người ngoài', () => {
  it('người ngoài đã đăng nhập, gửi slug của trường → vẫn KHÔNG thấy tin nội bộ', async () => {
    const titles = await titlesSeenBy(outsider, { 'X-Org-Slug': SLUG })
    expect(titles).not.toContain('Tin NỘI BỘ của trường')
    // Vẫn phải thấy tin công khai — siết quá tay thì gãy cả trục danh mục.
    expect(titles).toContain('Tin CÔNG KHAI từ trường')
  })

  it('khách CHƯA đăng nhập, gửi slug của trường → vẫn KHÔNG thấy tin nội bộ', async () => {
    const res = await request(app).get('/api/v1/listings').set({ 'X-Org-Slug': SLUG }).expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).not.toContain('Tin NỘI BỘ của trường')
    expect(titles).toContain('Tin CÔNG KHAI từ trường')
  })

  it('THÀNH VIÊN gửi slug thì VẪN thấy tin nội bộ — chốt không siết quá tay', async () => {
    const titles = await titlesSeenBy(member, { 'X-Org-Slug': SLUG })
    expect(titles).toContain('Tin NỘI BỘ của trường')
  })

  /*
   * Master không thuộc trường nào nhưng có grant `master/system`, nên nhánh
   * `canModerateAnyInOrg` phải giữ nguyên `withOrg()` — không có nó thì bàn duyệt tin của
   * master trắng trơn.
   */
  it('MASTER gửi slug vẫn đọc được tin nội bộ để duyệt', async () => {
    const titles = await titlesSeenBy(master, { 'X-Org-Slug': SLUG })
    expect(titles).toContain('Tin NỘI BỘ của trường')
  })
})

/*
 * `?visibility=` — thứ mục "TIN TRONG NHÓM" ở hồ sơ nhóm cần.
 *
 * Scope đọc là "nhánh org HOẶC nhánh công khai", nên không lọc gì thì mục đó hứng luôn cả trục
 * công khai: một nhóm vừa tạo, chưa mời ai, chưa có tin nào, vẫn bày ra 6 tin lạ.
 */
describe('?visibility= thu hẹp về đúng tin của nhóm', () => {
  it('org_internal cho thành viên → chỉ tin nội bộ, không lẫn tin công khai', async () => {
    const res = await request(app)
      .get('/api/v1/listings?visibility=org_internal')
      .set({ ...bearer(member), 'X-Org-Slug': SLUG })
      .expect(200)
    const titles = res.body.data.map((l: { title: string }) => l.title)

    expect(titles).toContain('Tin NỘI BỘ của trường')
    expect(titles).not.toContain('Tin CÔNG KHAI từ trường')
    expect(titles).not.toContain('Tin CÔNG KHAI không thuộc trường nào')
  })

  it('org_internal cho người ngoài → RỖNG, bộ lọc không thành cửa hậu', async () => {
    const res = await request(app)
      .get('/api/v1/listings?visibility=org_internal')
      .set({ ...bearer(outsider), 'X-Org-Slug': SLUG })
      .expect(200)

    expect(res.body.data).toHaveLength(0)
  })
})

describe('THÀNH VIÊN org đọc được gì', () => {
  it('thấy tin nội bộ của trường mình', async () => {
    const titles = await titlesSeenBy(member, { 'X-Org-Slug': SLUG })
    expect(titles).toContain('Tin NỘI BỘ của trường')
  })

  /**
   * Chốt của cả cơ chế hai trục: tin `public` do người trong trường đăng GIỮ NGUYÊN
   * `organizationId`, nên nó khớp CẢ hai vế đọc — vế org (vì thành viên đọc được org đó) lẫn vế
   * công khai. Một tin, hai đường tới, không phải hai bản ghi.
   */
  it('thấy LUÔN tin công khai của trường mình — một tin nằm trên cả hai trục', async () => {
    const titles = await titlesSeenBy(member, { 'X-Org-Slug': SLUG })

    expect(titles).toContain('Tin CÔNG KHAI từ trường')
    // Và nó vẫn mang org — org là "đăng bởi trường nào", không phải "ai được đọc".
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const doc = await runUnscoped('test đọc organizationId', () =>
      Listing.findOne({ title: 'Tin CÔNG KHAI từ trường' })
        .select('organizationId visibility')
        .lean()
        .exec(),
    )
    expect(doc?.organizationId).not.toBeNull()
    expect(doc?.visibility).toBe('public')
  })

  it('thấy cả tin công khai của người không thuộc trường nào', async () => {
    const titles = await titlesSeenBy(member, { 'X-Org-Slug': SLUG })
    expect(titles).toContain('Tin CÔNG KHAI không thuộc trường nào')
  })
})
