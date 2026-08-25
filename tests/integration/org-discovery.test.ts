import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createTestApp,
  joinCodeOf,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Khám phá nhóm: tìm theo tên → mở hồ sơ → xin vào, KHÔNG cần mã.
 *
 * Đây là một sự đảo ngược có chủ ý của luật cũ ("chỉ vào được bằng mã"), nên nửa sau của file
 * mới là phần quan trọng: nhóm RIÊNG TƯ phải giữ nguyên luật cũ. Mất vế đó thì cái mã hết tác
 * dụng và hàng đợi duyệt của mọi nhóm thành bề mặt mở.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let owner: TestUser
let seeker: TestUser

const OPEN = 'cho-do-cu-hung-vuong'
const SECRET = 'do-dien-tu-sinh-vien'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  owner = await registerUser(app, 'chu-nhom@truong.local', 'Chủ nhóm')
  seeker = await registerUser(app, 'nguoi-tim@example.com', 'Người tìm nhóm')

  await createOrg(app, master.token, {
    name: 'Chợ đồ cũ Hùng Vương',
    slug: OPEN,
    ownerEmail: owner.email,
  })
  await createOrg(app, master.token, {
    name: 'Đồ điện tử sinh viên',
    slug: SECRET,
    ownerEmail: owner.email,
  })

  // Nhóm thứ hai chuyển sang RIÊNG TƯ — trạng thái mà cả tính năng này phải tôn trọng.
  const { Organization } = await import('../../src/features/organization/organization.model')
  await Organization.updateOne({ slug: SECRET }, { isPublic: false }).exec()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const slugs = (body: { data: { slug: string }[] }) => body.data.map((o) => o.slug)

describe('Tìm nhóm — chỉ nhóm công khai lộ ra', () => {
  it('bỏ trống từ khoá thì trả danh sách gợi ý, không phải lỗi', async () => {
    const res = await request(app).get('/api/v1/organizations/lookup').expect(200)
    expect(slugs(res.body)).toContain(OPEN)
  })

  it('mỗi dòng có đủ số thành viên và mã để dựng thẻ nhóm', async () => {
    const res = await request(app).get('/api/v1/organizations/lookup?q=cho do cu').expect(200)
    const row = res.body.data.find((o: { slug: string }) => o.slug === OPEN)

    expect(row).toMatchObject({ name: 'Chợ đồ cũ Hùng Vương' })
    expect(typeof row.memberCount).toBe('number')
    expect(row.joinCode).toBeTruthy()
  })

  /** Chốt của cả thiết kế: gõ ĐÚNG TÊN nhóm riêng tư vẫn không thấy gì. */
  it('nhóm RIÊNG TƯ không lộ ra dù gõ đúng tên', async () => {
    const res = await request(app).get('/api/v1/organizations/lookup?q=do dien tu').expect(200)
    expect(slugs(res.body)).not.toContain(SECRET)
  })
})

describe('Hồ sơ nhóm công khai', () => {
  it('khách CHƯA đăng nhập vẫn đọc được — phải xem trước khi quyết định vào', async () => {
    const res = await request(app).get(`/api/v1/organizations/profile/${OPEN}`).expect(200)

    expect(res.body.data).toMatchObject({ name: 'Chợ đồ cũ Hùng Vương', slug: OPEN })
    expect(res.body.data.joined).toBe(false)
    expect(typeof res.body.data.postsThisWeek).toBe('number')
    expect(Array.isArray(res.body.data.rules)).toBe(true)
  })

  it('người đã ở trong nhóm thấy cờ joined — nút không mời họ vào lại', async () => {
    const res = await request(app)
      .get(`/api/v1/organizations/profile/${OPEN}`)
      .set(bearer(owner))
      .expect(200)
    expect(res.body.data.joined).toBe(true)
  })

  /**
   * 404 chứ không 403: 403 xác nhận "có nhóm ở slug này, chỉ là không cho xem" — đủ để quét
   * slug rồi lập ra danh sách các nhóm kín.
   */
  it('hồ sơ nhóm RIÊNG TƯ trả 404, không phân biệt được với slug không tồn tại', async () => {
    const real = await request(app).get(`/api/v1/organizations/profile/${SECRET}`)
    const fake = await request(app).get('/api/v1/organizations/profile/khong-ton-tai-dau')

    expect(real.status).toBe(404)
    expect(fake.status).toBe(404)
  })
})

describe('Xin vào nhóm', () => {
  it('nhóm CÔNG KHAI: gửi bằng slug, không cần mã', async () => {
    const res = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(seeker))
      .send({ slug: OPEN, claimedName: 'Người tìm nhóm' })

    expect(res.status).toBe(201)
  })

  /** Vế giữ cho cái mã còn nguyên tác dụng. Mất nó là mất toàn bộ lớp chống spam. */
  it('nhóm RIÊNG TƯ: gửi bằng slug bị TỪ CHỐI', async () => {
    const res = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(seeker))
      .send({ slug: SECRET, claimedName: 'Người tìm nhóm' })

    expect(res.status).toBe(404)
  })

  it('nhóm RIÊNG TƯ: có MÃ thì vẫn vào được như trước', async () => {
    const code = await joinCodeOf(SECRET)
    const res = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(seeker))
      .send({ code, claimedName: 'Người tìm nhóm' })

    expect(res.status).toBe(201)
  })

  it('gửi cả hai hoặc không gửi gì đều bị chặn ở schema', async () => {
    const both = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(seeker))
      .send({ slug: OPEN, code: 'ABCD', claimedName: 'X' })
    expect(both.status).toBe(400)

    const neither = await request(app)
      .post('/api/v1/join-requests')
      .set(bearer(seeker))
      .send({ claimedName: 'X' })
    expect(neither.status).toBe(400)
  })
})

describe('Gõ MÃ vào ô tìm — lối tắt vào thẳng nhóm', () => {
  it('mã của nhóm công khai trả đúng một nhóm đó', async () => {
    const code = await joinCodeOf(OPEN)
    const res = await request(app).get(`/api/v1/organizations/lookup?q=${code}`).expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].slug).toBe(OPEN)
  })

  /**
   * Nhóm RIÊNG TƯ cũng ra — và đó là đúng: cầm được mã vốn đã là điều kiện vào nhóm kín, y hệt
   * `GET /organizations/by-code` vẫn cho từ trước, sau cùng một `lookupLimiter`. Chốt này canh
   * đúng ranh giới: lộ qua MÃ thì được, lộ qua TÊN thì không.
   */
  it('mã của nhóm RIÊNG TƯ cũng ra, dù tên của nó thì không', async () => {
    const code = await joinCodeOf(SECRET)
    const byCode = await request(app).get(`/api/v1/organizations/lookup?q=${code}`).expect(200)
    expect(byCode.body.data[0]?.slug).toBe(SECRET)

    const byName = await request(app).get('/api/v1/organizations/lookup?q=do dien tu').expect(200)
    expect(slugs(byName.body)).not.toContain(SECRET)
  })
})

describe('Hai lỗi thật gặp lúc dùng', () => {
  /**
   * Org tạo TRƯỚC khi `isPublic` ra đời không có field đó. `default: true` của mongoose chỉ áp
   * cho document MỚI, còn filter chạy dưới MongoDB — nên `{ isPublic: true }` trượt sạch dữ
   * liệu cũ và mọi nhóm đang có biến mất khỏi tìm kiếm lẫn hồ sơ.
   *
   * Test tự ghi thẳng vào collection để dựng lại đúng hình dạng đó: đi qua `Organization.create`
   * là mongoose điền default vào, và bài test sẽ xanh trong khi production đỏ.
   */
  it('org tạo trước khi có field `isPublic` vẫn được coi là công khai', async () => {
    await mongoose.connection.db!.collection('organizations').insertOne({
      name: 'Nhóm Đời Cũ',
      slug: 'nhom-doi-cu',
      slugNormalized: 'nhomdoicu',
      nameTokens: ['nhom', 'doi', 'cu'],
      joinCode: 'OLD777',
      status: 'active',
      deletedAt: null,
      allowJoinRequests: true,
      allowOutsiderPosts: true,
      rules: [],
    })

    const found = await request(app).get('/api/v1/organizations/lookup?q=nhom doi cu').expect(200)
    expect(slugs(found.body)).toContain('nhom-doi-cu')

    await request(app).get('/api/v1/organizations/profile/nhom-doi-cu').expect(200)
  })

  /**
   * Quản trị của một nhóm RIÊNG TƯ mở hồ sơ nhóm mình. Lọc `isPublic` ở repository thì chính
   * người đang quản nhóm cũng nhận 404 — vô lý với người dùng và không bảo vệ được gì.
   */
  it('thành viên nhóm RIÊNG TƯ mở được hồ sơ nhóm mình', async () => {
    const res = await request(app)
      .get(`/api/v1/organizations/profile/${SECRET}`)
      .set(bearer(owner))
      .expect(200)

    expect(res.body.data).toMatchObject({ slug: SECRET, joined: true })
  })

  /** Vế đối xứng: người NGOÀI vẫn không thấy gì, nếu không thì chốt riêng tư mất tác dụng. */
  it('người ngoài vẫn nhận 404 trên hồ sơ nhóm riêng tư', async () => {
    const nobody = await registerUser(app, 'khong-lien-quan@example.com', 'Không liên quan')
    const res = await request(app)
      .get(`/api/v1/organizations/profile/${SECRET}`)
      .set(bearer(nobody))
    expect(res.status).toBe(404)
  })
})
