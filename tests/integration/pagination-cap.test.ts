import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
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
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { PAGINATION } from '../../src/common/constants'

/**
 * Mỗi trang TỐI ĐA 10 dòng — và client không xin hơn được.
 *
 * Một hằng số, mọi danh sách: test này cắm vào ba endpoint ở ba tầng khác nhau (bảng tin công
 * khai, hộp lời mời của org, hàng đợi đơn xin vào) để chứng minh trần đi từ `PAGINATION` xuống,
 * không phải từ một con số gõ tay ở từng schema. Hai danh sách sau trước đây trả HẾT (đơn) hoặc
 * cắt cứng 200 (lời mời) — đúng loại "trả cả kho cho một màn vẽ được mười dòng".
 *
 * `limit=11` là 400 chứ không bị kẹp âm thầm: kẹp là để một client cũ tưởng mình đang nhận 50
 * dòng trong khi chỉ có 10, rồi tự kết luận "hết dữ liệu". Từ chối rõ để lỗi nổi lên ở chỗ gọi.
 */

const OVER = PAGINATION.MAX_LIMIT + 1

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let owner: TestUser
let seller: TestUser
let orgId = ''
const SLUG = 'nhom-phan-trang'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  const categoryId = await createCategory('Đồ dùng', 'do-dung-pt')
  master = await makeMaster(app)
  owner = await registerUser(app, 'chu@pt.local', 'Chủ nhóm')
  seller = await registerUser(app, 'ban@pt.local', 'Người bán')
  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm PT', slug: SLUG, ownerEmail: owner.email })
  ).id

  // 11 = trần + 1: đủ để trang đầu đầy và trang hai còn đúng một dòng. Cùng giá để máy quét không
  // giữ tin nào lại vì lệch giá; tiêu đề khác nhau để không bị coi là đăng trùng.
  for (let i = 1; i <= OVER; i++) {
    await request(app)
      .post('/api/v1/listings')
      .set({ Authorization: `Bearer ${seller.token}` })
      .send({
        ...listingPayload(`Món số ${i}`, categoryId),
        visibility: 'public',
        provinceCode: 'Hồ Chí Minh',
      })
      .expect(201)
    await request(app)
      .post('/api/v1/invites')
      .set(orgAuth(owner.token, SLUG))
      .send({ channel: 'email', value: `nguoi${i}@moi.local` })
      .expect(201)
  }

  // Đơn xin vào chèn thẳng — 11 tài khoản đi qua API là 11 lượt đăng ký chỉ để có 11 dòng.
  // CÙNG một `createdAt` cho cả 11 dòng, có chủ ý: đây là hình dạng của dữ liệu seed (một vòng
  // lặp, một mốc giờ), và là ca làm `sort({ createdAt })` + `skip/limit` lặp dòng giữa hai trang
  // nếu không có khoá phụ `_id`. Đã thấy thật: trang 2 của danh sách tổ chức lặp 2 dòng trang 1.
  const { JoinRequest } = await import('../../src/features/join-request/join-request.model')
  const sameMoment = new Date('2026-01-15T08:00:00.000Z')
  await JoinRequest.insertMany(
    Array.from({ length: OVER }, (_, i) => ({
      userId: new Types.ObjectId(),
      organizationId: new Types.ObjectId(orgId),
      claimedName: `Học sinh ${i + 1}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: sameMoment,
      updatedAt: sameMoment,
    })),
  )
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

type Page = { data: unknown[]; meta: { limit: number; total: number; hasNextPage: boolean } }

describe('Trần 10 dòng một trang, mọi danh sách', () => {
  it('GET /listings: mặc định đúng 10, trang hai còn một', async () => {
    const p1 = (await request(app).get('/api/v1/listings').expect(200)).body as Page
    expect(p1.data).toHaveLength(PAGINATION.MAX_LIMIT)
    expect(p1.meta).toMatchObject({ limit: PAGINATION.MAX_LIMIT, total: OVER, hasNextPage: true })

    const p2 = (await request(app).get('/api/v1/listings?page=2').expect(200)).body as Page
    expect(p2.data).toHaveLength(1)
    expect(p2.meta.hasNextPage).toBe(false)
  }, 60_000)

  it('xin hơn trần là 400, không bị kẹp âm thầm; đúng trần thì 200', async () => {
    await request(app).get(`/api/v1/listings?limit=${OVER}`).expect(400)
    await request(app).get(`/api/v1/listings?limit=${PAGINATION.MAX_LIMIT}`).expect(200)
  }, 60_000)

  it('GET /invites: từ "cắt cứng 200" thành phân trang thật', async () => {
    const p1 = (
      await request(app).get('/api/v1/invites').set(orgAuth(owner.token, SLUG)).expect(200)
    ).body as Page
    expect(p1.data).toHaveLength(PAGINATION.MAX_LIMIT)
    expect(p1.meta).toMatchObject({ total: OVER, hasNextPage: true })
    await request(app)
      .get(`/api/v1/invites?limit=${OVER}`)
      .set(orgAuth(owner.token, SLUG))
      .expect(400)
  }, 60_000)

  it('GET /join-requests: từ "trả hết" thành phân trang thật', async () => {
    const p1 = (
      await request(app).get('/api/v1/join-requests').set(orgAuth(owner.token, SLUG)).expect(200)
    ).body as Page
    expect(p1.data).toHaveLength(PAGINATION.MAX_LIMIT)
    expect(p1.meta).toMatchObject({ total: OVER, hasNextPage: true })

    const p2 = (
      await request(app)
        .get('/api/v1/join-requests?page=2')
        .set(orgAuth(owner.token, SLUG))
        .expect(200)
    ).body as Page
    expect(p2.data).toHaveLength(1)

    // Hai trang ghép lại phải đủ 11 dòng KHÁC NHAU dù cả 11 cùng `createdAt`.
    const ids = [...p1.data, ...p2.data].map((r) => (r as { id: string }).id)
    expect(new Set(ids).size).toBe(OVER)
  }, 60_000)
})
