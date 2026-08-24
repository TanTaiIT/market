import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createTestApp,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * `GET /organizations` — bảng tổ chức của master.
 *
 * Tồn tại vì master cố ý KHÔNG thuộc org nào (quyền của họ là grant `master/system`, không phải
 * membership), nên `/organizations/mine` luôn rỗng với họ và bộ chuyển tổ chức phía client không
 * có gì để đặt vào `X-Org-Slug`. Test ở đây khoá đúng ba thứ khiến endpoint này khác `lookup`:
 * chỉ master gọi được, có trả `id`, và trả cả org đang bị khoá.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let outsider: TestUser
let suspendedId = ''

const url = '/api/v1/organizations'
const asMaster = (query = '') =>
  request(app).get(`${url}${query}`).set('Authorization', `Bearer ${master.token}`)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  outsider = await registerUser(app, 'nguoi-ngoai@example.com', 'Người ngoài')
  const owner = await registerUser(app, 'owner@truong.local', 'Owner')

  await createOrg(app, master.token, {
    name: 'Trường Lý Thường Kiệt',
    slug: 'truong-ly-thuong-kiet',
    ownerEmail: owner.email,
  })
  suspendedId = (
    await createOrg(app, master.token, {
      name: 'Chung Cư Hưng Vương',
      slug: 'chung-cu-hung-vuong',
      ownerEmail: owner.email,
    })
  ).id

  await request(app)
    .patch(`${url}/${suspendedId}/status`)
    .set('Authorization', `Bearer ${master.token}`)
    .send({ status: 'suspended' })
    .expect(200)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('GET /organizations — cửa vào', () => {
  it('không đăng nhập thì 401', async () => {
    await request(app).get(url).expect(401)
  })

  it('người thường 403 — đây là bảng quản trị, không phải dropdown công khai', async () => {
    await request(app).get(url).set('Authorization', `Bearer ${outsider.token}`).expect(403)
  })

  /**
   * Chốt của cả tính năng: master không có membership nào, mà vẫn phải gọi được. Thêm nhầm
   * `requireOrg` vào route này là khoá vòng tròn — cần org scope để lấy danh sách org.
   */
  it('master KHÔNG thuộc org nào vẫn gọi được, không cần X-Org-Slug', async () => {
    const mine = await request(app)
      .get(`${url}/mine`)
      .set('Authorization', `Bearer ${master.token}`)
      .expect(200)
    expect(mine.body.data).toHaveLength(0)

    const res = await asMaster().expect(200)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('GET /organizations — nội dung bảng', () => {
  /** `lookup` cố tình giấu `id`; ở đây `id` chính là thứ endpoint tồn tại để trả. */
  it('trả id và slug — đủ để client đặt vào X-Org-Slug', async () => {
    const res = await asMaster().expect(200)
    for (const row of res.body.data) {
      expect(row.id).toMatch(/^[0-9a-f]{24}$/)
      expect(row.slug).toBeTruthy()
    }
  })

  it('trả cả org đang bị khoá — đó là thứ master cần xử lý, không phải thứ nên giấu', async () => {
    const res = await asMaster().expect(200)
    const suspended = res.body.data.find((o: { id: string }) => o.id === suspendedId)
    expect(suspended?.status).toBe('suspended')
  })

  it('lọc theo status thu hẹp đúng một dòng', async () => {
    const res = await asMaster('?status=active').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].slug).toBe('truong-ly-thuong-kiet')
  })

  it('meta phân trang khớp với limit đã gửi', async () => {
    const res = await asMaster('?limit=1').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, hasNextPage: true })
  })
})

describe('GET /organizations — tìm kiếm', () => {
  it('gõ KHÔNG DẤU vẫn ra: tìm trên nameTokens/slugNormalized đã fold dấu', async () => {
    const res = await asMaster('?q=hung vuong').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(suspendedId)
  })

  it('nhiều từ là AND, không phải OR', async () => {
    // "ly" khớp Lý Thường Kiệt, "hung" khớp Hưng Vương — OR sẽ trả cả hai.
    const res = await asMaster('?q=ly hung').expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  /** `lookup` bắt tối thiểu 2 ký tự; bảng quản trị thì bỏ trống = liệt kê tất cả. */
  it('q rỗng liệt kê tất cả thay vì báo lỗi', async () => {
    const res = await asMaster('?q=').expect(200)
    expect(res.body.data).toHaveLength(2)
  })
})
