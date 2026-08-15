import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

let categoryId = ''
const owner = { token: '', id: '' }
const member = { token: '', id: '' }
const otherOrg = { token: '', id: '' }
let listingId = ''

const PASSWORD = 'password123'

async function registerOwner(slug: string) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({
      organizationName: `Org ${slug}`,
      organizationSlug: slug,
      name: `Owner ${slug}`,
      email: `owner@${slug}.local`,
      password: PASSWORD,
    })
    .expect(201)
  return { token: res.body.data.tokens.accessToken as string, id: res.body.data.user.id as string }
}

async function addMember(orgSlug: string, name: string, email: string) {
  const { Organization } = await import('../../src/features/organization/organization.model')
  const { User } = await import('../../src/features/user/user.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')

  const org = await Organization.findOne({ slug: orgSlug }).exec()
  await runUnscoped('test fixture: thêm thành viên', () =>
    User.create({
      organizationId: org!._id,
      name,
      email,
      password: PASSWORD,
      isEmailVerified: true,
    }),
  )
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ orgSlug, email, password: PASSWORD })
    .expect(200)
  return { token: res.body.data.tokens.accessToken as string, id: res.body.data.user.id as string }
}

async function createListing(token: string, title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title,
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://example.com/a.jpg'],
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

  Object.assign(owner, await registerOwner('mod-a'))
  Object.assign(otherOrg, await registerOwner('mod-b'))
  Object.assign(member, await addMember('mod-a', 'Thành viên', 'member@mod-a.local'))

  listingId = await createListing(owner.token, 'Đèn học chống cận có kẹp bàn')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const as = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` })

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
    const second = await createListing(owner.token, 'Bán tài khoản game giá rẻ')
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
