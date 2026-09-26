import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  listingPayload,
  makeMaster,
  registerUser,
  seedBannedPhrases,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Ba chốt của chat (audit 4.5): bấm "Nhắn tin" hai lần cùng lúc không 500, tin nhắn qua cổng cụm
 * cấm, và tin đã bán/hết hạn không mở được hội thoại MỚI (hội thoại cũ vẫn tiếp tục).
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let buyer: TestUser
let other: TestUser
let categoryId = ''
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function post() {
  seq += 1
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(seller))
    .send({
      ...listingPayload(`Tin số ${seq}`, categoryId),
      reach: 'marketplace',
      provinceCode: 'Hồ Chí Minh',
    })
    .expect(201)
  expect(res.body.data.status).toBe('active')
  return res.body.data._id as string
}

const open = (who: TestUser, listingId: string) =>
  request(app).post('/api/v1/chats').set(bearer(who)).send({ listingId })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-chat')
  master = await makeMaster(app)
  await seedBannedPhrases(master.id)
  seller = await registerUser(app, 'seller@chat.local', 'Người bán')
  buyer = await registerUser(app, 'buyer@chat.local', 'Người mua')
  other = await registerUser(app, 'other@chat.local', 'Người mua khác')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Chat — chốt', () => {
  it('bấm "Nhắn tin" hai lần cùng lúc: cả hai thành công và là CÙNG một hội thoại', async () => {
    const listingId = await post()
    const [a, b] = await Promise.all([open(buyer, listingId), open(buyer, listingId)])

    expect([200, 201]).toContain(a.status)
    expect([200, 201]).toContain(b.status)
    expect(a.body.data.id ?? a.body.data._id).toBe(b.body.data.id ?? b.body.data._id)
  }, 60_000)

  it('tin nhắn chứa cụm cấm → 400, không được ghi', async () => {
    const listingId = await post()
    const convo = await open(buyer, listingId)
    const id = convo.body.data.id ?? convo.body.data._id

    await request(app)
      .post(`/api/v1/chats/${id}/messages`)
      .set(bearer(buyer))
      .send({ text: 'Có bán kèm ma túy không bạn' })
      .expect(400)

    const messages = await request(app)
      .get(`/api/v1/chats/${id}/messages`)
      .set(bearer(buyer))
      .expect(200)
    expect(messages.body.data).toHaveLength(0)
  }, 60_000)

  it('tin đã bán: hội thoại đã có vẫn mở lại được, người mới thì 409', async () => {
    const listingId = await post()
    await open(buyer, listingId).expect(201)
    await request(app).post(`/api/v1/listings/${listingId}/sold`).set(bearer(seller)).expect(200)

    const again = await open(buyer, listingId)
    expect([200, 201]).toContain(again.status)

    await open(other, listingId).expect(409)
  }, 60_000)
})
