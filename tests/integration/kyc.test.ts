import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, makeMaster, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * CỔNG KYC — lớp phủ tuân thủ của Bộ Công Thương.
 *
 * Hai nhóm ca, và nhóm THỨ HAI mới là nhóm phải canh: cái cổng này có tự khoá chính nó không.
 * Nếu người chưa duyệt không nộp được hồ sơ, hoặc master không vào được để duyệt, thì bật cờ
 * lên là cả hệ thống chết mà không ai còn cửa nào sửa.
 *
 * `KYC_REQUIRED` đặt trong `beforeAll` thay vì `.env`: nó phải BẬT cho file này và TẮT cho mọi
 * file khác — tắt là hệ thống chạy y như chưa từng có module này, và 77 file test còn lại
 * chứng minh đúng điều đó.
 */
let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let seller: TestUser

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const INDIVIDUAL = {
  subjectType: 'individual',
  fullName: 'Nguyễn Văn A',
  birthDate: '1995-03-12',
  idNumber: '079095001234',
}

beforeAll(async () => {
  process.env.KYC_REQUIRED = 'true'
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  seller = await registerUser(app, 'ban-hang@kyc.local', 'Người bán')
}, 120_000)

afterAll(async () => {
  process.env.KYC_REQUIRED = 'false'
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Cổng KYC chặn đúng thứ cần chặn', () => {
  it('tài khoản chưa nộp hồ sơ → 403 ở đường nghiệp vụ', async () => {
    const res = await request(app).get('/api/v1/listings/mine').set(bearer(seller))
    expect(res.status).toBe(403)
    expect(res.body.message).toContain('chưa được duyệt')
  }, 60_000)

  it('KHÁCH chưa đăng nhập vẫn đọc được tin công khai', async () => {
    // Bộ hỏi về danh tính NGƯỜI BÁN, không về người xem — chặn khách là chặn nhầm đối tượng.
    await request(app).get('/api/v1/listings').expect(200)
  }, 60_000)
})

describe('Cổng KYC KHÔNG tự khoá chính nó', () => {
  it('người chưa duyệt vẫn nộp được hồ sơ và xem được trạng thái', async () => {
    const posted = await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(seller))
      .send(INDIVIDUAL)
      .expect(201)
    expect(posted.body.data.status).toBe('pending')
    // Số định danh KHÔNG có trong DTO thường — chỉ đường duyệt của master mới trả nó.
    expect(posted.body.data.idNumber).toBeUndefined()

    const mine = await request(app).get('/api/v1/kyc/me').set(bearer(seller)).expect(200)
    expect(mine.body.data.status).toBe('pending')
  }, 60_000)

  it('master vào được bàn duyệt dù chính họ chưa có hồ sơ', async () => {
    const list = await request(app)
      .get('/api/v1/kyc?status=pending')
      .set(bearer(master))
      .expect(200)
    expect(list.body.data).toHaveLength(1)
  }, 60_000)

  it('người thường KHÔNG mở được bàn duyệt', async () => {
    await request(app).get('/api/v1/kyc').set(bearer(seller)).expect(403)
  }, 60_000)
})

describe('Duyệt và từ chối', () => {
  it('duyệt xong thì tài khoản dùng được ngay', async () => {
    const id = (await request(app).get('/api/v1/kyc/me').set(bearer(seller)).expect(200)).body.data
      .id

    // Master đọc được số định danh để đối chiếu — đường DUY NHẤT trả về nó.
    const detail = await request(app).get(`/api/v1/kyc/${id}`).set(bearer(master)).expect(200)
    expect(detail.body.data.idNumber).toBe(INDIVIDUAL.idNumber)
    expect(detail.body.data.accountEmail).toBe(seller.email)

    await request(app).patch(`/api/v1/kyc/${id}/approve`).set(bearer(master)).expect(200)
    await request(app).get('/api/v1/listings/mine').set(bearer(seller)).expect(200)
  }, 60_000)

  it('hồ sơ ĐÃ DUYỆT thì khoá — sửa số định danh phải đi qua người duyệt', async () => {
    const res = await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(seller))
      .send({ ...INDIVIDUAL, idNumber: '079095009999' })
    expect(res.status).toBe(409)
  }, 60_000)

  it('từ chối thì tài khoản khoá lại, và nộp lại được kèm lý do đã xoá', async () => {
    const other = await registerUser(app, 'bi-tu-choi@kyc.local', 'Người bị từ chối')
    const posted = await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(other))
      .send(INDIVIDUAL)
      .expect(201)

    await request(app)
      .patch(`/api/v1/kyc/${posted.body.data.id}/reject`)
      .set(bearer(master))
      .send({ reason: 'Ảnh giấy tờ mờ' })
      .expect(200)

    await request(app).get('/api/v1/listings/mine').set(bearer(other)).expect(403)
    const after = await request(app).get('/api/v1/kyc/me').set(bearer(other)).expect(200)
    expect(after.body.data.rejectReason).toBe('Ảnh giấy tờ mờ')

    const again = await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(other))
      .send(INDIVIDUAL)
      .expect(201)
    expect(again.body.data.status).toBe('pending')
    // Lý do cũ phải biến mất, không thì người nộp đọc lý do của bản trước trên bản mới.
    expect(again.body.data.rejectReason).toBeNull()
  }, 60_000)
})

describe('Hình dạng hồ sơ theo đối tượng', () => {
  it('công ty thiếu mã số doanh nghiệp → 400', async () => {
    const u = await registerUser(app, 'cty-thieu@kyc.local', 'Công ty thiếu')
    await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(u))
      // Thiếu `companyTaxCode` — `discriminatedUnion` của zod chặn ngay ở cửa.
      .send({
        subjectType: 'company',
        companyName: 'Công ty TNHH Thử',
        companyAddress: '12 Nguyễn Huệ, Quận 1',
        fullName: INDIVIDUAL.fullName,
        birthDate: INDIVIDUAL.birthDate,
        idNumber: INDIVIDUAL.idNumber,
      })
      .expect(400)
  }, 60_000)

  it('công ty đủ trường thì qua, và ba trường cá nhân là của NGƯỜI ĐẠI DIỆN', async () => {
    const u = await registerUser(app, 'cty-du@kyc.local', 'Công ty đủ')
    const res = await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(u))
      .send({
        subjectType: 'company',
        companyName: 'Công ty TNHH Thử',
        companyAddress: '12 Nguyễn Huệ, Quận 1',
        companyTaxCode: '0312345678',
        fullName: 'Trần Thị B',
        birthDate: '1988-07-01',
        idNumber: '079088005678',
      })
      .expect(201)
    expect(res.body.data.companyName).toBe('Công ty TNHH Thử')
    expect(res.body.data.fullName).toBe('Trần Thị B')
  }, 60_000)

  it('số định danh sai hình dạng → 400', async () => {
    const u = await registerUser(app, 'cccd-sai@kyc.local', 'Sai số')
    await request(app)
      .post('/api/v1/kyc/me')
      .set(bearer(u))
      .send({ ...INDIVIDUAL, idNumber: 'ABC123' })
      .expect(400)
  }, 60_000)
})
