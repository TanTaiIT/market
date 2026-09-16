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
} from '../helpers/fixtures'

/**
 * Dọn hộp thư — hội thoại và thông báo.
 *
 * Cả hai tính năng trả lời cùng một câu hỏi khó: dữ liệu KHÔNG thuộc riêng người bấm xoá. Hội
 * thoại thuộc về hai người, thông báo phát chung thuộc về cả nhóm. Nên phần lớn số test dưới
 * đây không kiểm "đã xoá chưa" mà kiểm **người kia không mất gì** — đó mới là chỗ dễ vỡ.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Chủ org, đồng thời là người bán trong mọi hội thoại dưới đây. */
let seller: TestUser
let buyer: TestUser
/** Thành viên thứ ba, KHÔNG bấm xoá gì cả — chứng nhân cho việc dọn là của riêng người bấm. */
let bystander: TestUser

let orgId = ''
let categoryId = ''
let conversationId = ''
let secondConversationId = ''

const SLUG = 'inbox-org'
const asSeller = () => orgAuth(seller.token, SLUG)
const asBuyer = () => orgAuth(buyer.token, SLUG)
const asBystander = () => orgAuth(bystander.token, SLUG)

/**
 * Mốc dọn có độ phân giải mili-giây và so bằng `$gt`, nên một document tạo trong CÙNG mili-giây
 * với lần dọn sẽ bị nuốt. Test chạy nhanh hơn thế, nên phải tự tách hai thời điểm ra — không
 * phải thói quen ngủ chờ cho hết flaky.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function newListing(title: string) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(asSeller())
    .send(listingPayload(title, categoryId))
    .expect(201)
  const id = res.body.data._id
  await publishListing(id)
  return id
}

async function openChat(listingId: string) {
  const res = await request(app)
    .post('/api/v1/chats')
    .set(asBuyer())
    .send({ listingId })
    .expect(201)
  return res.body.data.id as string
}

const send = (who: () => Record<string, string>, id: string, text: string) =>
  request(app).post(`/api/v1/chats/${id}/messages`).set(who()).send({ text }).expect(201)

const inbox = (who: () => Record<string, string>) =>
  request(app).get('/api/v1/chats').set(who()).expect(200)

const history = (who: () => Record<string, string>, id: string) =>
  request(app).get(`/api/v1/chats/${id}/messages`).set(who()).expect(200)

const notifications = (who: () => Record<string, string>) =>
  request(app).get('/api/v1/notifications').set(who()).expect(200)

const announce = (title: string) =>
  request(app)
    .post('/api/v1/notifications')
    .set(asSeller())
    .send({ title, body: 'Nội dung thông báo dùng cho test dọn hộp thư' })
    .expect(201)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@inbox.local', 'Người bán')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Tổ chức Hộp Thư',
      slug: SLUG,
      ownerEmail: seller.email,
    })
  ).id

  buyer = await registerUser(app, 'buyer@inbox.local', 'Người mua')
  await addMember(buyer.id, orgId)
  bystander = await registerUser(app, 'bystander@inbox.local', 'Người ngoài cuộc')
  await addMember(bystander.id, orgId)

  categoryId = await createCategory()

  conversationId = await openChat(await newListing('Đèn bàn LED ba mức sáng còn bảo hành'))
  await send(asBuyer, conversationId, 'Đèn còn không bạn ơi?')
  await send(asSeller, conversationId, 'Còn nhé, bạn qua lấy lúc nào cũng được')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Xoá một hội thoại', () => {
  it('người lạ đoán id nhận 404, không phải một lệnh ghi im lặng', async () => {
    await request(app).delete(`/api/v1/chats/${conversationId}`).set(asBystander()).expect(404)

    // Và hội thoại vẫn còn nguyên với người trong cuộc.
    const before = await inbox(asBuyer)
    expect(before.body.data).toHaveLength(1)
  })

  it('biến mất khỏi hộp thư người xoá, còn nguyên ở hộp thư người kia', async () => {
    await request(app).delete(`/api/v1/chats/${conversationId}`).set(asBuyer()).expect(200)

    expect((await inbox(asBuyer)).body.data).toHaveLength(0)

    const sellerInbox = await inbox(asSeller)
    expect(sellerInbox.body.data).toHaveLength(1)
    expect(sellerInbox.body.data[0].id).toBe(conversationId)
  })

  it('cắt lịch sử của riêng người xoá — người kia vẫn đọc đủ', async () => {
    expect((await history(asBuyer, conversationId)).body.data).toHaveLength(0)
    expect((await history(asSeller, conversationId)).body.data).toHaveLength(2)
  })

  it('người kia nhắn tiếp thì hội thoại quay lại, nhưng chỉ mang tin mới', async () => {
    await tick()
    await send(asSeller, conversationId, 'Mình vẫn giữ hàng cho bạn nhé')

    const back = await inbox(asBuyer)
    expect(back.body.data).toHaveLength(1)
    expect(back.body.data[0].id).toBe(conversationId)

    // Đúng MỘT tin: `touch` gỡ cờ ẩn nhưng không đụng tới mốc cắt, nên hai tin trước khi xoá
    // không sống lại cùng hội thoại.
    const seen = await history(asBuyer, conversationId)
    expect(seen.body.data).toHaveLength(1)
    expect(seen.body.data[0].text).toMatch(/vẫn giữ hàng/)

    // Người bán không mất gì trong suốt màn này: 2 tin cũ + 1 tin vừa gửi.
    expect((await history(asSeller, conversationId)).body.data).toHaveLength(3)
  })
})

describe('Xoá tất cả hội thoại', () => {
  it('dọn sạch hộp thư người gọi và trả về số đã dọn', async () => {
    secondConversationId = await openChat(await newListing('Ghế xoay văn phòng còn êm'))
    await send(asBuyer, secondConversationId, 'Ghế này còn chứ bạn?')
    expect((await inbox(asBuyer)).body.data).toHaveLength(2)

    const res = await request(app).delete('/api/v1/chats').set(asBuyer()).expect(200)
    expect(res.body.data.deleted).toBe(2)
    expect((await inbox(asBuyer)).body.data).toHaveLength(0)
  })

  it('người bán không mất hội thoại nào', async () => {
    expect((await inbox(asSeller)).body.data).toHaveLength(2)
  })

  it('gọi lần hai không đụng vào hội thoại đã ẩn', async () => {
    /*
     * `deleted: 0` không phải chuyện thẩm mỹ. Câu lọc cố ý chỉ nhận `hidden: false`, nếu không
     * lần gọi thứ hai sẽ ĐẨY mốc cắt lên hiện tại và nuốt luôn những tin đến trong lúc hội
     * thoại đang ẩn — người dùng mất tin mà không hề bấm xoá lần nào nữa.
     */
    const res = await request(app).delete('/api/v1/chats').set(asBuyer()).expect(200)
    expect(res.body.data.deleted).toBe(0)
  })
})

describe('Xoá tất cả thông báo', () => {
  it('dọn xong hộp thư rỗng', async () => {
    await announce('Thông báo trước khi dọn')
    expect((await notifications(asBuyer)).body.data.length).toBeGreaterThan(0)

    await request(app).delete('/api/v1/notifications').set(asBuyer()).expect(200)
    expect((await notifications(asBuyer)).body.data).toHaveLength(0)
  })

  it('thông báo gửi SAU khi dọn vẫn tới', async () => {
    await tick()
    await announce('Thông báo sau khi dọn')

    const after = await notifications(asBuyer)
    expect(after.body.data).toHaveLength(1)
    expect(after.body.data[0].title).toBe('Thông báo sau khi dọn')
  })

  it('không xoá document nào — người khác vẫn đọc được thông báo cũ', async () => {
    /*
     * Chốt quan trọng nhất của cả tính năng: thông báo phát chung là MỘT document dùng chung
     * cho cả nhóm. Nếu ai đó cài đặt "xoá" thành xoá document, test này là thứ đỏ lên.
     */
    const titles = (await notifications(asBystander)).body.data.map(
      (n: { title: string }) => n.title,
    )
    expect(titles).toContain('Thông báo trước khi dọn')
    expect(titles).toContain('Thông báo sau khi dọn')
  })
})
