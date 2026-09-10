import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  listingPayload,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { User } from '../../src/features/user/user.model'
import { bucketLabel } from '../../src/common/report/timeBuckets'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let categoryId = ''
const HCM = 'Hồ Chí Minh'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ cũ', 'do-cu-user-report')
  master = await makeMaster(app)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

const report = (query: Record<string, string>, who: TestUser = master) =>
  request(app).get('/api/v1/users/report').query(query).set(bearer(who))

/**
 * Lùi ngày tạo qua driver gốc — `timestamps: true` làm `createdAt` immutable nên Mongoose
 * tước nó khỏi update rồi trả `{ acknowledged: false }`: lệnh "thành công" mà không chạm DB.
 */
const backdate = (id: string, at: Date) =>
  User.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { createdAt: at } })

const todayPoint = async () => {
  const res = await report({ granularity: 'day' }).expect(200)
  return res.body.data.points.at(-1)
}

describe('Báo cáo người dùng — cổng master', () => {
  it('người thường không xem được, khách thì 401', async () => {
    const someone = await registerUser(app, 'plain@ureport.local', 'Người thường')
    await report({ granularity: 'day' }, someone).expect(403)
    await request(app).get('/api/v1/users/report').expect(401)
  }, 60_000)
})

describe('Báo cáo người dùng — chuỗi thời gian', () => {
  it('đủ cột, cột rỗng bằng 0, và nói rõ múi giờ gộp', async () => {
    const res = await report({ granularity: 'day' }).expect(200)
    const { points, timezone, granularity } = res.body.data

    expect(granularity).toBe('day')
    expect(timezone).toBe('Asia/Ho_Chi_Minh')
    expect(points).toHaveLength(30)
    expect(points.at(-1).bucket).toBe(bucketLabel(new Date(), 'day'))
    // Người dùng của test đều tạo hôm nay, nên ngày đầu cửa sổ phải là 0 chứ không vắng mặt.
    expect(points[0].users).toBe(0)
  }, 60_000)

  /**
   * Đường cộng dồn phải khởi điểm từ số người đã có TRƯỚC cửa sổ. Thiếu mốc nền đó thì cột đầu
   * bắt đầu từ 0 và người đọc tưởng sàn mới có người từ đầu kỳ báo cáo.
   */
  it('total cộng dồn và tính cả người có trước cửa sổ', async () => {
    const veteran = await registerUser(app, 'veteran@ureport.local', 'Người cũ')
    await backdate(veteran.id, new Date('2024-01-15T03:00:00Z'))

    const res = await report({ granularity: 'day' }).expect(200)
    const points = res.body.data.points

    // Người cũ nằm ngoài cửa sổ 30 ngày -> không phải "mới", nhưng phải có trong nền cộng dồn.
    expect(points[0].total).toBeGreaterThan(0)
    expect(points.at(-1).total).toBe(res.body.data.totals.total)
    // Cộng dồn không bao giờ đi lùi.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].total).toBeGreaterThanOrEqual(points[i - 1].total)
    }
  }, 60_000)

  it('users đếm tài khoản mới, active đếm người có đăng tin — hai con số khác nhau', async () => {
    const before = await todayPoint()

    // Ba người mới, chỉ MỘT người đăng tin.
    const poster = await registerUser(app, 'poster@ureport.local', 'Có đăng tin')
    await registerUser(app, 'lurker1@ureport.local', 'Chỉ xem 1')
    await registerUser(app, 'lurker2@ureport.local', 'Chỉ xem 2')
    await request(app)
      .post('/api/v1/listings')
      .set(bearer(poster))
      .send({
        ...listingPayload('Tin của người mới', categoryId),
        visibility: 'public',
        provinceCode: HCM,
      })
      .expect(201)

    const after = await todayPoint()
    expect(after.users).toBe(before.users + 3)
    expect(after.active).toBe(before.active + 1)
  }, 60_000)

  /** Người đã rời sàn không còn là tăng trưởng — đếm họ là tự khen mình bằng số cũ. */
  it('tài khoản đã xoá mềm rơi khỏi báo cáo', async () => {
    const quitter = await registerUser(app, 'quitter@ureport.local', 'Người rời đi')
    const before = await todayPoint()

    await request(app).delete('/api/v1/users/me').set(bearer(quitter)).expect(200)

    const after = await todayPoint()
    expect(after.users).toBe(before.users - 1)
    expect(after.total).toBe(before.total - 1)
  }, 60_000)

  it('gộp theo tháng và theo năm', async () => {
    const old = await registerUser(app, 'old@ureport.local', 'Người của 2025')
    await backdate(old.id, new Date('2025-04-15T03:00:00Z'))

    const byMonth = await report({
      granularity: 'month',
      from: '2025-04-01T00:00:00.000Z',
      to: new Date().toISOString(),
    }).expect(200)
    expect(
      byMonth.body.data.points.find((p: { bucket: string }) => p.bucket === '2025-04').users,
    ).toBe(1)

    const byYear = await report({
      granularity: 'year',
      from: '2025-01-01T00:00:00.000Z',
      to: new Date().toISOString(),
    }).expect(200)
    expect(byYear.body.data.points.find((p: { bucket: string }) => p.bucket === '2025').users).toBe(
      1,
    )
  }, 60_000)
})
