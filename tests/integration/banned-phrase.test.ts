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
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
const ORG_SLUG = 'tu-dien-cam'

const asMaster = () => ({ Authorization: `Bearer ${master.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@banned.local', 'Người bán')
  await createOrg(app, master.token, {
    name: 'Org từ điển cấm',
    slug: ORG_SLUG,
    ownerEmail: seller.email,
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function postListing(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, ORG_SLUG))
    .send({
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
      ...body,
    })
}

describe('Từ điển cụm cấm — CRUD của master', () => {
  let phraseId = ''

  it('master thêm cụm, được chuẩn hoá lowercase + trim', async () => {
    const res = await request(app)
      .post('/api/v1/banned-phrases')
      .set(asMaster())
      .send({ phrase: '  Kích Điện Bắt Cá ' })
      .expect(201)

    expect(res.body.data.phrase).toBe('kích điện bắt cá')
    phraseId = res.body.data._id
  })

  it('thêm trùng — kể cả khác hoa thường — là 409', async () => {
    await request(app)
      .post('/api/v1/banned-phrases')
      .set(asMaster())
      .send({ phrase: 'KÍCH ĐIỆN BẮT CÁ' })
      .expect(409)
  })

  it('người thường không đọc được danh sách — công bố là chỉ đường lách luật', async () => {
    await request(app)
      .get('/api/v1/banned-phrases')
      .set({ Authorization: `Bearer ${seller.token}` })
      .expect(403)
  })

  it('cụm vừa thêm có hiệu lực NGAY với tin đăng mới — cache bị xoá khi ghi', async () => {
    const res = await postListing({
      title: 'Bộ kích điện bắt cá công suất lớn',
    }).expect(201)

    expect(res.body.data.status).toBe('rejected')
  }, 60_000)

  it('master gỡ cụm → tin tương tự đăng lại đi qua bình thường', async () => {
    await request(app).delete(`/api/v1/banned-phrases/${phraseId}`).set(asMaster()).expect(200)

    const res = await postListing({
      title: 'Bộ kích điện bắt cá đăng sau khi gỡ luật',
    }).expect(201)

    // Không còn bị cấm — vào hàng đợi thường (seller bậc 0, và đã dính một án ở test trên).
    expect(res.body.data.status).toBe('pending')
  }, 60_000)

  it('gỡ một id không tồn tại là 404', async () => {
    await request(app).delete(`/api/v1/banned-phrases/${phraseId}`).set(asMaster()).expect(404)
  })
})
