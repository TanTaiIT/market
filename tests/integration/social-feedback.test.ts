import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, makeMaster, registerUser, startTestDb } from '../helpers/fixtures'

/**
 * Tiếp nhận + công bố ý kiến của tổ chức xã hội (cụm TẠM THỜI).
 *
 * Hai chốt mang tính bảo mật, không phải tính năng:
 *
 * 1. Cửa GHI mở cho người KHÔNG đăng nhập — đó là điểm của nghĩa vụ công bố, nhưng nó cũng
 *    là bề mặt ghi rộng nhất của app. Nên bản gửi lên phải nằm ở `pending` và KHÔNG được
 *    lọt ra đường đọc công khai trước khi master duyệt.
 * 2. Bản công khai không mang `status`. Trả nó ra là để người ngoài đọc được quy trình duyệt
 *    và biết có bao nhiêu ý kiến bị giấu.
 */

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let nguoiThuong: TestUser
let pendingId = ''

const GUI = {
  orgName: 'Hội Bảo vệ người tiêu dùng tỉnh Bình Thuận',
  decisionNo: '1234/QĐ-UBND',
  content: 'Đề nghị sàn bổ sung đầu mối tiếp nhận khiếu nại ngay tại trang chủ.',
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  nguoiThuong = await registerUser(app, 'thuong@social.local', 'Người thường')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const publicList = () => request(app).get('/api/v1/social-feedback')

describe('Gửi ý kiến — cửa công khai', () => {
  it('khách KHÔNG đăng nhập gửi được', async () => {
    const res = await request(app).post('/api/v1/social-feedback').send(GUI).expect(201)

    expect(res.body.data.orgName).toBe(GUI.orgName)
    pendingId = res.body.data.id
    // Bản trả về người gửi cũng không mang `status` — cùng DTO với đường công khai.
    expect(res.body.data.status).toBeUndefined()
  }, 60_000)

  it('nội dung quá ngắn → 400', async () => {
    await request(app)
      .post('/api/v1/social-feedback')
      .send({ ...GUI, content: 'ok' })
      .expect(400)
  }, 60_000)

  it('thiếu số quyết định → 400', async () => {
    await request(app)
      .post('/api/v1/social-feedback')
      .send({ orgName: GUI.orgName, content: GUI.content })
      .expect(400)
  }, 60_000)

  /** Chốt then chốt: gửi xong KHÔNG có nghĩa là đã công bố. */
  it('ý kiến vừa gửi CHƯA hiện ở danh sách công khai', async () => {
    const res = await publicList().expect(200)
    expect(res.body.data).toHaveLength(0)
  }, 60_000)
})

describe('Bàn duyệt — master-only', () => {
  it('khách xem hàng đợi → 401', async () => {
    await request(app).get('/api/v1/social-feedback/review').expect(401)
  }, 60_000)

  it('người thường xem hàng đợi → 403', async () => {
    await request(app).get('/api/v1/social-feedback/review').set(auth(nguoiThuong)).expect(403)
  }, 60_000)

  it('người thường tự duyệt → 403', async () => {
    await request(app)
      .patch(`/api/v1/social-feedback/${pendingId}`)
      .set(auth(nguoiThuong))
      .send({ status: 'published' })
      .expect(403)
  }, 60_000)

  it('master thấy ý kiến đang chờ, kèm `status`', async () => {
    const res = await request(app)
      .get('/api/v1/social-feedback/review')
      .set(auth(master))
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('pending')
    expect(res.body.meta.total).toBe(1)
  }, 60_000)

  it('id không tồn tại → 404', async () => {
    await request(app)
      .patch(`/api/v1/social-feedback/${new mongoose.Types.ObjectId().toString()}`)
      .set(auth(master))
      .send({ status: 'published' })
      .expect(404)
  }, 60_000)

  it('trạng thái lạ → 400 (không đặt lại về `pending` được)', async () => {
    await request(app)
      .patch(`/api/v1/social-feedback/${pendingId}`)
      .set(auth(master))
      .send({ status: 'pending' })
      .expect(400)
  }, 60_000)
})

describe('Công bố', () => {
  it('master duyệt → ý kiến lên danh sách công khai', async () => {
    await request(app)
      .patch(`/api/v1/social-feedback/${pendingId}`)
      .set(auth(master))
      .send({ status: 'published' })
      .expect(200)

    const res = await publicList().expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].content).toBe(GUI.content)
  }, 60_000)

  /** Chốt chống rò rỉ: đường công khai không được kể chuyện nội bộ. */
  it('bản công khai KHÔNG mang `status`, `reviewedAt` hay người duyệt', async () => {
    const res = await publicList().expect(200)
    const row = res.body.data[0]

    expect(Object.keys(row).sort()).toEqual(
      ['content', 'createdAt', 'decisionNo', 'id', 'orgName'].sort(),
    )
  }, 60_000)

  it('ý kiến bị từ chối KHÔNG lên danh sách công khai', async () => {
    const gui = await request(app)
      .post('/api/v1/social-feedback')
      .send({ ...GUI, content: 'Nội dung này sẽ bị từ chối vì không liên quan.' })
      .expect(201)

    await request(app)
      .patch(`/api/v1/social-feedback/${gui.body.data.id}`)
      .set(auth(master))
      .send({ status: 'rejected' })
      .expect(200)

    const res = await publicList().expect(200)
    expect(res.body.data).toHaveLength(1)

    // Bản ghi vẫn còn — từ chối là không công bố, không phải xoá dấu vết.
    const queue = await request(app)
      .get('/api/v1/social-feedback/review?status=rejected')
      .set(auth(master))
      .expect(200)
    expect(queue.body.data).toHaveLength(1)
  }, 60_000)
})
