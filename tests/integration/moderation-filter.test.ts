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
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Bàn duyệt lọc ở SERVER (`category`, `q`) — hệ quả trực tiếp của phân trang 10 dòng.
 *
 * Bản app cũ lấy 100 dòng rồi lọc tại chỗ. Với trang 10 dòng, lọc tại chỗ là danh sách ngắn hơn
 * màn hình, `onEndReached` bắn liên tiếp và kéo hết mọi trang về ngay lúc mở màn (đã thấy 12
 * request nối đuôi trong log). Nên hai bộ lọc chuyển xuống đây, và `meta.total` phải là con số
 * CỦA bộ lọc — đó là thứ badge và ô "N kết quả" hiển thị.
 */

let app: Application
let mongod: MongoMemoryReplSet
let owner: TestUser
let phoneCat = ''
let bookCat = ''
const SLUG = 'nhom-loc-duyet'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  phoneCat = await createCategory('Điện thoại', 'dien-thoai-loc')
  bookCat = await createCategory('Sách', 'sach-loc')
  const master = await makeMaster(app)
  owner = await registerUser(app, 'chu@loc.local', 'Chủ nhóm')
  await createOrg(app, master.token, { name: 'Nhóm lọc', slug: SLUG, ownerEmail: owner.email })

  for (const [title, categoryId] of [
    ['Điện thoại cũ còn tốt', phoneCat],
    ['Sách giáo khoa lớp 12', bookCat],
    ['Sách tham khảo toán', bookCat],
  ] as const) {
    await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(owner.token, SLUG))
      .send({ ...listingPayload(title, categoryId), orgSlug: SLUG })
      .expect(201)
  }
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const list = (query: string) =>
  request(app).get(`/api/v1/moderation/listings?${query}`).set(orgAuth(owner.token, SLUG))
const titles = (res: request.Response) => (res.body.data as { title: string }[]).map((l) => l.title)

describe('GET /moderation/listings — lọc phía server', () => {
  it('không lọc → cả ba; theo danh mục → đúng hai; `total` đi theo bộ lọc', async () => {
    const all = await list('').expect(200)
    expect(all.body.meta.total).toBe(3)

    const books = await list(`category=${bookCat}`).expect(200)
    expect(titles(books).sort()).toEqual(['Sách giáo khoa lớp 12', 'Sách tham khảo toán'])
    expect(books.body.meta.total).toBe(2)
  }, 60_000)

  it('`q` khớp tiêu đề không phân biệt hoa thường, và khớp tên người đăng', async () => {
    expect(titles(await list(`q=${encodeURIComponent('GIÁO KHOA')}`).expect(200))).toEqual([
      'Sách giáo khoa lớp 12',
    ])
    // Tên người đăng là snapshot `posterName` trên tin — cả ba tin đều của "Chủ nhóm".
    expect((await list(`q=${encodeURIComponent('chủ nhóm')}`).expect(200)).body.meta.total).toBe(3)
  }, 60_000)

  it('kết hợp danh mục + từ khoá, và không khớp thì rỗng chứ không lỗi', async () => {
    const res = await list(`category=${bookCat}&q=${encodeURIComponent('toán')}`).expect(200)
    expect(titles(res)).toEqual(['Sách tham khảo toán'])

    const none = await list(`q=zzz-khong-co`).expect(200)
    expect(none.body.data).toEqual([])
    expect(none.body.meta.total).toBe(0)
  }, 60_000)
})
