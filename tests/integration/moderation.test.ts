import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

let categoryId = ''
const owner = { token: '', id: '', slug: '' }
const member = { token: '', id: '', slug: '' }
const otherOrg = { token: '', id: '', slug: '' }
let listingId = ''

let masterToken = ''
const orgIds: Record<string, string> = {}

/** Chủ org nhận grant `manager` scope org ngay khi master tạo org — đó là quyền vào bàn duyệt. */
async function createOwner(slug: string) {
  const { registerUser, createOrg } = await import('../helpers/fixtures')
  const user = await registerUser(app, `owner@${slug}.local`, `Owner ${slug}`)
  const org = await createOrg(app, masterToken, {
    name: `Org ${slug}`,
    slug,
    ownerEmail: user.email,
  })
  orgIds[slug] = org.id
  return { token: user.token, id: user.id, slug }
}

/** Thành viên thường: có membership nhưng KHÔNG có grant nào — không vào được bàn duyệt. */
async function joinOrg(slug: string, name: string, email: string) {
  const { registerUser, addMember } = await import('../helpers/fixtures')
  const user = await registerUser(app, email, name)
  await addMember(user.id, orgIds[slug])
  return { token: user.token, id: user.id, slug }
}

async function createListing(who: { token: string; slug: string }, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(as(who))
    .send({
      title,
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    .expect(201)
  return res.body.data._id as string
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const uri = mongod.getUri()
  process.env.MONGO_URI = uri
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(uri)
  const { createApp } = await import('../../src/app')
  app = createApp()

  const { Category } = await import('../../src/features/category/category.model')
  categoryId = (await Category.create({ name: 'Đồ dùng', slug: 'do-dung' }))._id.toString()

  const { makeMaster } = await import('../helpers/fixtures')
  masterToken = (await makeMaster(app)).token

  Object.assign(owner, await createOwner('mod-a'))
  Object.assign(otherOrg, await createOwner('mod-b'))
  Object.assign(member, await joinOrg('mod-a', 'Thành viên', 'member@mod-a.local'))

  listingId = await createListing(owner, 'Đèn học chống cận có kẹp bàn')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function as(who: { token: string; slug: string }) {
  return { Authorization: `Bearer ${who.token}`, 'X-Org-Slug': who.slug }
}

describe('Moderation — phân quyền', () => {
  it('thành viên thường không vào được bàn quản trị', async () => {
    const res = await request(app).get('/api/v1/moderation/overview').set(as(member))
    expect(res.status).toBe(403)
  })

  it('không token thì 401', async () => {
    const res = await request(app).get('/api/v1/moderation/overview')
    expect(res.status).toBe(401)
  })

  it('owner xem được thẻ số', async () => {
    const res = await request(app).get('/api/v1/moderation/overview').set(as(owner)).expect(200)
    expect(res.body.data.pending).toBe(1)
    expect(res.body.data.live).toBe(0)
    expect(res.body.data.users).toBe(2)
    expect(res.body.data.openReports).toBe(0)
    expect(Array.isArray(res.body.data.trend)).toBe(true)
    expect(res.body.data.categories[0].name).toBe('Đồ dùng')
  })
})

describe('Moderation — duyệt tin', () => {
  it('tin chờ duyệt KHÔNG lọt ra endpoint công khai', async () => {
    const res = await request(app).get('/api/v1/listings').set(as(member)).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('nhưng bàn quản trị thì thấy', async () => {
    const res = await request(app)
      .get('/api/v1/moderation/listings?status=pending')
      .set(as(owner))
      .expect(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('từ chối mà thiếu lý do bị chặn ở schema', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${listingId}`)
      .set(as(owner))
      .send({ status: 'rejected' })
    expect(res.status).toBe(400)
  })

  it('ghim tin lên bảng, và nó hiện ra ở endpoint công khai', async () => {
    await request(app)
      .patch(`/api/v1/moderation/listings/${listingId}`)
      .set(as(owner))
      .send({ status: 'active' })
      .expect(200)

    const res = await request(app).get('/api/v1/listings').set(as(member)).expect(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('thao tác duyệt để lại vết kiểm toán', async () => {
    const res = await request(app).get('/api/v1/moderation/activity').set(as(owner)).expect(200)
    expect(res.body.data[0].action).toBe('listing.approve')
    expect(res.body.data[0].summary).toMatch(/Ghim "Đèn học/)
    expect(res.body.data[0].actorName).toBe('Owner mod-a')
  })

  it('từ chối kèm lý do thì lý do được lưu lại trên tin', async () => {
    const second = await createListing(owner, 'Bán tài khoản game giá rẻ')
    await request(app)
      .patch(`/api/v1/moderation/listings/${second}`)
      .set(as(owner))
      .send({ status: 'rejected', reason: 'Món đồ không được phép bán' })
      .expect(200)

    const res = await request(app)
      .get('/api/v1/moderation/listings?status=rejected')
      .set(as(owner))
      .expect(200)
    expect(res.body.data[0].moderation.reason).toBe('Món đồ không được phép bán')
    expect(res.body.data[0].moderation.byName).toBe('Owner mod-a')
  })

  /**
   * Lý do lưu trên tin là dữ liệu KÉO — người đăng phải tự mở lại tin mới thấy. Thông báo đích
   * danh là vế đẩy, và nó chỉ tồn tại từ khi `Notification` có cột `userId`.
   */
  it('người đăng nhận được thông báo kèm lý do từ chối', async () => {
    const third = await createListing(owner, 'Vé xem phim đã qua sử dụng')
    await request(app)
      .patch(`/api/v1/moderation/listings/${third}`)
      .set(as(owner))
      .send({ status: 'rejected', reason: 'Vé đã dùng không bán lại được' })
      .expect(200)

    const inbox = await request(app).get('/api/v1/notifications').set(as(owner)).expect(200)
    const rejected = inbox.body.data.find(
      (n: { title: string }) => n.title === 'Tin của bạn bị từ chối',
    )
    expect(rejected).toBeDefined()
    expect(rejected.body).toContain('Vé đã dùng không bán lại được')
  })

  it('org khác không đụng được tin của org này', async () => {
    const res = await request(app)
      .patch(`/api/v1/moderation/listings/${listingId}`)
      .set(as(otherOrg))
      .send({ status: 'hidden' })
    expect(res.status).toBe(404)
  })
})

describe('Report — gửi và xử lý', () => {
  let reportId = ''

  it('thành viên báo cáo được một tin', async () => {
    const res = await request(app).post('/api/v1/reports').set(as(member)).send({
      targetType: 'listing',
      targetId: listingId,
      kind: 'scam',
      quote: 'Bạn này yêu cầu chuyển khoản trước rồi mới cho xem hàng',
    })

    expect(res.status).toBe(201)
    expect(res.body.data.targetTitle).toMatch(/Đèn học/)
    expect(res.body.data.reporterName).toBe('Thành viên')
    reportId = res.body.data.id
  })

  it('cùng một người báo cáo lại đối tượng đó thì bị chặn', async () => {
    const res = await request(app).post('/api/v1/reports').set(as(member)).send({
      targetType: 'listing',
      targetId: listingId,
      kind: 'scam',
      quote: 'Gửi lại lần nữa cho chắc, nội dung đủ dài',
    })
    expect(res.status).toBe(409)
  })

  it('thành viên thường KHÔNG đọc được hàng đợi báo cáo', async () => {
    const res = await request(app).get('/api/v1/reports').set(as(member))
    expect(res.status).toBe(403)
  })

  it('thẻ số của bàn quản trị đếm được báo cáo mở', async () => {
    const res = await request(app).get('/api/v1/moderation/overview').set(as(owner)).expect(200)
    expect(res.body.data.openReports).toBe(1)
  })

  it('quản trị gỡ tin qua báo cáo — tin bị ẩn và báo cáo đóng lại', async () => {
    await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(as(owner))
      .send({ action: 'hide_target' })
      .expect(200)

    const open = await request(app).get('/api/v1/reports?status=open').set(as(owner)).expect(200)
    expect(open.body.data).toHaveLength(0)

    const listings = await request(app).get('/api/v1/listings').set(as(member)).expect(200)
    expect(listings.body.data).toHaveLength(0)
  })

  it('xử lại báo cáo đã đóng thì bị từ chối', async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/${reportId}`)
      .set(as(owner))
      .send({ action: 'ignore' })
    expect(res.status).toBe(400)
  })

  it('không tự báo cáo chính mình', async () => {
    const res = await request(app).post('/api/v1/reports').set(as(member)).send({
      targetType: 'user',
      targetId: member.id,
      kind: 'harassment',
      quote: 'Nội dung đủ dài để qua được validation',
    })
    expect(res.status).toBe(400)
  })

  it('org khác không thấy báo cáo của org này', async () => {
    const res = await request(app).get('/api/v1/reports').set(as(otherOrg)).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('báo cáo đối tượng không tồn tại trả 404', async () => {
    const res = await request(app).post('/api/v1/reports').set(as(member)).send({
      targetType: 'listing',
      targetId: new Types.ObjectId().toString(),
      kind: 'other',
      quote: 'Nội dung đủ dài để qua được validation',
    })
    expect(res.status).toBe(404)
  })
})

async function trustOf(userId: string) {
  const { trustRepository } = await import('../../src/features/trust/trust.repository')
  return trustRepository.levelOf(userId)
}

async function raiseTo(userId: string, level: number) {
  const { setTrustLevel } = await import('../helpers/fixtures')
  await setTrustLevel(userId, level)
}

/**
 * Hai đường làm hại NẶNG nhất từng không trừ uy tín gì cả: tin bị gỡ sau khi đã lên bảng, và
 * tin bị ẩn vì một báo cáo đã được xác minh. Cả hai đều là "đã lọt qua hệ thống rồi mới bị
 * phát hiện" — nếu chúng miễn phí thì bậc uy tín chỉ còn đo được khâu tiền kiểm.
 */
describe('Uy tín — hai đường hậu kiểm', () => {
  /** Người tố giác phải là thành viên CÙNG org thì mới đọc được tin nội bộ để mà báo cáo. */
  const buyer = { token: '', id: '', slug: '' }

  beforeAll(async () => {
    Object.assign(buyer, await joinOrg(owner.slug, 'Người mua', 'buyer@mod-trust.local'))
  }, 60_000)

  it('gỡ tin đã đăng làm tụt bậc người đăng', async () => {
    await raiseTo(member.id, 2)
    const id = await createListing(member, 'Tin sẽ bị gỡ khỏi bảng')

    await request(app).delete(`/api/v1/moderation/listings/${id}`).set(as(owner)).expect(200)

    expect(await trustOf(member.id)).toBe(1)
  })

  it('báo cáo được xác minh (ẩn tin) cũng làm tụt bậc', async () => {
    await raiseTo(member.id, 2)
    const id = await createListing(member, 'Tin bị tố giác và xác minh đúng')

    const report = await request(app)
      .post('/api/v1/reports')
      .set(as(buyer))
      .send({
        targetType: 'listing',
        targetId: id,
        kind: 'scam',
        quote: 'Người bán nhận cọc xong chặn liên lạc',
      })
      .expect(201)

    await request(app)
      .patch(`/api/v1/reports/${report.body.data.id}`)
      .set(as(owner))
      .send({ action: 'hide_target' })
      .expect(200)

    expect(await trustOf(member.id)).toBe(1)
  })

  it('đóng báo cáo bằng `ignore` thì KHÔNG trừ ai — bị tố oan không phải là lỗi', async () => {
    await raiseTo(member.id, 2)
    const id = await createListing(member, 'Tin bị tố oan')

    const report = await request(app)
      .post('/api/v1/reports')
      .set(as(buyer))
      .send({ targetType: 'listing', targetId: id, kind: 'wrong_info', quote: 'Tôi thấy sai sai' })
      .expect(201)

    await request(app)
      .patch(`/api/v1/reports/${report.body.data.id}`)
      .set(as(owner))
      .send({ action: 'ignore' })
      .expect(200)

    expect(await trustOf(member.id)).toBe(2)
  })
})

async function readDecision(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test đọc autoApproval', () =>
    Listing.findById(id).select('autoApproval status').lean().exec(),
  )
}

/** Vết quyết định tự đăng: có trong DB để điều tra, KHÔNG có trong response cho người xem. */
describe('Vết quyết định tự đăng', () => {
  it('tin bị giữ lại ghi đúng chốt đã chặn nó', async () => {
    const { setTrustLevel } = await import('../helpers/fixtures')
    await setTrustLevel(member.id, 0)
    const id = await createListing(member, 'Tin của người bậc 0')

    const doc = await readDecision(id)
    expect(doc?.status).toBe('pending')
    expect(doc?.autoApproval).toMatchObject({ trustLevel: 0, reason: 'trust_too_low' })
  })

  it('tin tự đăng ghi lại bậc uy tín tại thời điểm đăng', async () => {
    const { setTrustLevel } = await import('../helpers/fixtures')
    await setTrustLevel(member.id, 2)
    const created = await request(app)
      .post('/api/v1/listings')
      .set(as(member))
      .send({
        title: 'Tin tự đăng của người bậc 2',
        description: 'Mô tả đủ dài cho zod schema đi qua',
        price: 150000,
        categoryId,
        images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
        location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      })
      .expect(201)

    // Không rò ra ngoài: hồ sơ kiểm duyệt không thuộc về trang tin.
    expect(created.body.data.autoApproval).toBeUndefined()

    const doc = await readDecision(created.body.data._id)
    expect(doc?.status).toBe('active')
    expect(doc?.autoApproval).toMatchObject({ trustLevel: 2, reason: 'approved' })
  })
})

/**
 * Đường THĂNG bậc, đi qua nguyên tầng HTTP.
 *
 * Các test khác chỉ ép bậc bằng fixture rồi kiểm nó tụt. Không có ca nào chứng minh bậc thật
 * sự lên được — mà đó mới là đường quyết định ai được tự đăng tin.
 */
describe('Uy tín — thăng bậc qua API', () => {
  it('5 tin được người duyệt thông qua thì lên bậc 1', async () => {
    const climber = await joinOrg(owner.slug, 'Người leo bậc', 'climber@mod-trust.local')
    expect(await trustOf(climber.id)).toBe(0)

    for (let i = 0; i < 5; i += 1) {
      const id = await createListing(climber, `Tin sạch số ${i + 1}`)
      await request(app)
        .patch(`/api/v1/moderation/listings/${id}`)
        .set(as(owner))
        .send({ status: 'active' })
        .expect(200)
    }

    expect(await trustOf(climber.id)).toBe(1)
  }, 60_000)

  it('từ chối tin của người bậc 0 KHÔNG đẻ ra bản ghi uy tín rỗng', async () => {
    const rookie = await joinOrg(owner.slug, 'Người mới', 'rookie@mod-trust.local')
    const id = await createListing(rookie, 'Tin đầu tiên bị từ chối')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(as(owner))
      .send({ status: 'rejected', reason: 'Ảnh không rõ sản phẩm' })
      .expect(200)

    const { UserTrust } = await import('../../src/features/trust/trust.model')
    expect(await UserTrust.findOne({ userId: rookie.id }).lean().exec()).toBeNull()
    expect(await trustOf(rookie.id)).toBe(0)
  }, 60_000)
})

describe('Nhật ký hoạt động mang theo hậu quả uy tín', () => {
  it('dòng log của lượt từ chối nói rõ bậc còn lại', async () => {
    await raiseTo(member.id, 2)
    const id = await createListing(member, 'Tin bị từ chối có ghi bậc')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(as(owner))
      .send({ status: 'rejected', reason: 'Ảnh không rõ sản phẩm' })
      .expect(200)

    const feed = await request(app).get('/api/v1/moderation/activity').set(as(owner)).expect(200)

    expect(feed.body.data[0].summary).toMatch(/Tin bị từ chối có ghi bậc/)
    expect(feed.body.data[0].summary).toMatch(/uy tín bậc 1$/)
  }, 60_000)
})

/**
 * Sửa một tin ĐÃ LÊN BẢNG là đăng một tin mới bằng cửa sau. Trước đây `update` không hề chạm
 * `status`, nên cả cơ chế duyệt chỉ tốn đúng một lần lách: đăng tin sạch, đợi được duyệt, rồi
 * thay nội dung thành bất cứ thứ gì.
 */
describe('Sửa tin đang hiển thị thì phải duyệt lại', () => {
  /** Người sạch tiểu sử: `seller` đã dính vài lượt từ chối ở trên nên bị quota chặn. */
  const seller = { token: '', id: '', slug: '' }

  beforeAll(async () => {
    Object.assign(seller, await joinOrg(owner.slug, 'Người bán sửa tin', 'editor@mod-trust.local'))
  }, 60_000)
  /** Tin đi đúng đường thật: vào hàng đợi, được người duyệt cho lên bảng. */
  async function liveListing(title: string) {
    const id = await createListing(seller, title)
    await request(app)
      .patch(`/api/v1/moderation/listings/${id}`)
      .set(as(owner))
      .send({ status: 'active' })
      .expect(200)
    return id
  }

  it('người chưa đủ bậc đổi nội dung → tin rời bảng, quay lại hàng đợi', async () => {
    await raiseTo(seller.id, 0)
    const id = await liveListing('Tin sạch để được duyệt')

    await request(app)
      .patch(`/api/v1/listings/${id}`)
      .set(as(seller))
      .send({ title: 'Nội dung đã bị thay sau khi lên bảng' })
      .expect(200)

    const doc = await readDecision(id)
    expect(doc?.status).toBe('pending')
    expect(doc?.autoApproval).toMatchObject({ trustLevel: 0, reason: 'trust_too_low' })
  }, 60_000)

  it('người đủ bậc tự đăng sửa thoải mái — tin ở nguyên trên bảng', async () => {
    await raiseTo(seller.id, 2)
    const id = await createListing(seller, 'Tin tự đăng của người bậc 2')

    await request(app)
      .patch(`/api/v1/listings/${id}`)
      .set(as(seller))
      .send({ title: 'Đổi tiêu đề, vẫn tự đăng được' })
      .expect(200)

    expect((await readDecision(id))?.status).toBe('active')
  }, 60_000)

  it('gửi lại nguyên giá trị cũ thì không bị đá xuống — form sửa hay PATCH cả cụm', async () => {
    await raiseTo(seller.id, 0)
    const title = 'Tin chỉ đổi mỗi cờ thương lượng'
    const id = await liveListing(title)

    await request(app)
      .patch(`/api/v1/listings/${id}`)
      .set(as(seller))
      .send({ title, isNegotiable: true })
      .expect(200)

    expect((await readDecision(id))?.status).toBe('active')
  }, 60_000)

  it('tin còn trong hàng đợi thì sửa xong vẫn nằm đó, không tự bật lên', async () => {
    await raiseTo(seller.id, 0)
    const id = await createListing(seller, 'Tin còn chờ duyệt')

    await request(app)
      .patch(`/api/v1/listings/${id}`)
      .set(as(seller))
      .send({ price: 90000 })
      .expect(200)

    expect((await readDecision(id))?.status).toBe('pending')
  }, 60_000)
})
