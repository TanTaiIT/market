import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

let categoryId = ''

/** Org A: người bán + người mua. Org B: người ngoài, dùng để kiểm chứng cách ly tenant. */
const seller = { token: '', id: '', slug: '' }
const buyer = { token: '', id: '', slug: '' }
const outsiderSameOrg = { token: '', id: '', slug: '' }
const otherOrg = { token: '', id: '', slug: '' }

let listingId = ''
let conversationId = ''

let masterToken = ''
const orgIds: Record<string, string> = {}

/** Chủ org: master tạo org và chỉ định người chủ — không còn luồng tự đăng ký kèm org. */
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

/** Thành viên thứ hai — đường mời chưa làm, nên tạo membership thẳng ở tầng model. */
async function joinOrg(slug: string, name: string, email: string) {
  const { registerUser, addMember } = await import('../helpers/fixtures')
  const user = await registerUser(app, email, name)
  await addMember(user.id, orgIds[slug])
  return { token: user.token, id: user.id, slug }
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

  Object.assign(seller, await createOwner('chat-a'))
  Object.assign(otherOrg, await createOwner('chat-b'))
  Object.assign(buyer, await joinOrg('chat-a', 'Người mua', 'buyer@chat-a.local'))
  Object.assign(outsiderSameOrg, await joinOrg('chat-a', 'Người ngoài', 'outsider@chat-a.local'))

  const created = await request(app)
    .post('/api/v1/listings')
    .set(as(seller))
    .send({
      title: 'Đèn học chống cận có kẹp bàn',
      description: 'Đèn LED ba mức sáng, dùng nửa năm, còn nguyên hộp',
      price: 120000,
      categoryId,
      images: ['https://example.com/a.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    .expect(201)
  listingId = created.body.data._id

  // Tin mới vào PENDING và chưa có route duyệt tin — bật ACTIVE thẳng ở tầng model.
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test fixture: publish', () =>
    Listing.updateOne({ _id: listingId }, { status: 'active' }).exec(),
  )
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function as(who: { token: string; slug: string }) {
  return { Authorization: `Bearer ${who.token}`, 'X-Org-Slug': who.slug }
}

describe('Chat — mở hội thoại', () => {
  it('người mua mở được hội thoại với tin của người khác', async () => {
    const res = await request(app).post('/api/v1/chats').set(as(buyer)).send({ listingId })

    expect(res.status).toBe(201)
    expect(res.body.data.partnerName).toBe('Owner chat-a')
    expect(res.body.data.listingTitle).toMatch(/Đèn học/)
    expect(res.body.data.unread).toBe(false)
    conversationId = res.body.data.id
  })

  it('bấm lần hai trả lại đúng hội thoại cũ, không đẻ thêm', async () => {
    const res = await request(app)
      .post('/api/v1/chats')
      .set(as(buyer))
      .send({ listingId })
      .expect(201)
    expect(res.body.data.id).toBe(conversationId)

    const list = await request(app).get('/api/v1/chats').set(as(buyer)).expect(200)
    expect(list.body.data).toHaveLength(1)
  })

  it('người bán không mở hội thoại với chính tin của mình', async () => {
    const res = await request(app).post('/api/v1/chats').set(as(seller)).send({ listingId })
    expect(res.status).toBe(400)
  })

  it('tin không tồn tại trả 404', async () => {
    const res = await request(app)
      .post('/api/v1/chats')
      .set(as(buyer))
      .send({ listingId: new Types.ObjectId().toString() })
    expect(res.status).toBe(404)
  })
})

describe('Chat — gửi và đọc tin nhắn', () => {
  it('người mua gửi được tin nhắn', async () => {
    const res = await request(app)
      .post(`/api/v1/chats/${conversationId}/messages`)
      .set(as(buyer))
      .send({ text: 'Đèn còn không bạn ơi?' })

    expect(res.status).toBe(201)
    expect(res.body.data.senderName).toBe('Người mua')
  })

  it('nội dung rỗng bị từ chối', async () => {
    const res = await request(app)
      .post(`/api/v1/chats/${conversationId}/messages`)
      .set(as(buyer))
      .send({ text: '   ' })
    expect(res.status).toBe(400)
  })

  it('người bán thấy hội thoại sáng đèn chưa đọc', async () => {
    const res = await request(app).get('/api/v1/chats').set(as(seller)).expect(200)
    expect(res.body.data[0].unread).toBe(true)
    expect(res.body.data[0].lastMessage).toMatch(/Đèn còn không/)
  })

  it('người gửi KHÔNG tự thấy chưa đọc tin của chính mình', async () => {
    const res = await request(app).get('/api/v1/chats').set(as(buyer)).expect(200)
    expect(res.body.data[0].unread).toBe(false)
  })

  it('đánh dấu đã đọc thì tắt đèn', async () => {
    await request(app).patch(`/api/v1/chats/${conversationId}/read`).set(as(seller)).expect(200)

    const res = await request(app).get('/api/v1/chats').set(as(seller)).expect(200)
    expect(res.body.data[0].unread).toBe(false)
  })

  it('lịch sử trả tin mới nhất trước', async () => {
    await request(app)
      .post(`/api/v1/chats/${conversationId}/messages`)
      .set(as(seller))
      .send({ text: 'Còn bạn nhé' })
      .expect(201)

    const res = await request(app)
      .get(`/api/v1/chats/${conversationId}/messages`)
      .set(as(seller))
      .expect(200)

    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].text).toBe('Còn bạn nhé')
    expect(res.body.meta.total).toBe(2)
  })
})

describe('Chat — ai không thuộc hội thoại thì nhận 404, không phải 403', () => {
  it('người cùng org nhưng ngoài hội thoại không đọc được', async () => {
    const res = await request(app).get(`/api/v1/chats/${conversationId}`).set(as(outsiderSameOrg))
    expect(res.status).toBe(404)
  })

  it('người ngoài hội thoại không đọc được lịch sử', async () => {
    const res = await request(app)
      .get(`/api/v1/chats/${conversationId}/messages`)
      .set(as(outsiderSameOrg))
    expect(res.status).toBe(404)
  })

  it('người ngoài hội thoại không gửi được tin', async () => {
    const res = await request(app)
      .post(`/api/v1/chats/${conversationId}/messages`)
      .set(as(outsiderSameOrg))
      .send({ text: 'chen ngang' })
    expect(res.status).toBe(404)
  })

  it('org khác không thấy hội thoại của org này', async () => {
    const res = await request(app).get(`/api/v1/chats/${conversationId}`).set(as(otherOrg))
    expect(res.status).toBe(404)
  })

  it('org khác liệt kê hội thoại thì rỗng', async () => {
    const res = await request(app).get('/api/v1/chats').set(as(otherOrg)).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('không có token thì không vào được', async () => {
    const res = await request(app).get('/api/v1/chats')
    expect(res.status).toBe(401)
  })
})
