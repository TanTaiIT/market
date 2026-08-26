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
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Cấu hình hiển thị bảng tin — quản trị NHÓM đặt, không phải master và không phải người xem.
 *
 * Đặt ở `PATCH /organizations/current` chứ không ở một endpoint cấu hình riêng: nó là một
 * thuộc tính của tổ chức, đứng cạnh ảnh bìa và nội quy, và endpoint đó đã có sẵn đúng chốt
 * quyền cần thiết (`requireOrgAdmin`). Dựng thêm một bảng cấu hình hệ thống cho một enum hai
 * giá trị là thêm một collection, một endpoint và một lớp cache chỉ để chứa một chữ.
 *
 * File này cũng khoá luôn `rules` — cùng endpoint, và đường ghi của nó trước đây bị bỏ sót:
 * model có field, hồ sơ nhóm trả nó ra, nhưng schema `.strict()` lại từ chối khi client gửi lên.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let admin: TestUser
let member: TestUser

const SLUG = 'truong-bay-tin'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const patch = (u: TestUser, body: Record<string, unknown>) =>
  request(app).patch('/api/v1/organizations/current').set(orgAuth(u.token, SLUG)).send(body)

const layoutOf = async (u: TestUser) => {
  const res = await request(app).get('/api/v1/organizations/mine').set(bearer(u)).expect(200)
  return res.body.data.find((o: { slug: string }) => o.slug === SLUG)?.feedLayout
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  admin = await registerUser(app, 'quan-tri@truong.local', 'Quản trị nhóm')
  member = await registerUser(app, 'thanh-vien@truong.local', 'Thành viên thường')

  const org = await createOrg(app, master.token, {
    name: 'Trường Bày Tin',
    slug: SLUG,
    ownerEmail: admin.email,
  })

  const { addMember } = await import('../helpers/fixtures')
  await addMember(member.id, org.id)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Mặc định', () => {
  /**
   * `feed` chứ không `grid`: một tin một dòng đọc được cả mô tả lẫn ảnh lớn, nên nhóm mới lập
   * — lúc còn ít tin — nhìn không trống trải. Nhóm nhiều tin thì tự đổi sang lưới.
   */
  it('nhóm mới bày kiểu một-tin-một-dòng', async () => {
    expect(await layoutOf(admin)).toBe('feed')
  })
})

describe('Ai đổi được', () => {
  it('quản trị nhóm đổi sang lưới hai cột', async () => {
    await patch(admin, { feedLayout: 'grid' }).expect(200)
    expect(await layoutOf(admin)).toBe('grid')
  })

  /** Lựa chọn là của NHÓM: thành viên thường thấy đúng thứ quản trị đã đặt, không tự đổi được. */
  it('thành viên thường đọc được lựa chọn đó nhưng KHÔNG đổi được', async () => {
    expect(await layoutOf(member)).toBe('grid')

    const res = await patch(member, { feedLayout: 'feed' })
    expect(res.status).toBe(403)
    expect(await layoutOf(admin)).toBe('grid')
  })

  it('giá trị lạ bị chặn ở schema, không rơi vào DB', async () => {
    const res = await patch(admin, { feedLayout: 'masonry' })
    expect(res.status).toBe(400)
    expect(await layoutOf(admin)).toBe('grid')
  })

  it('đổi lại được về kiểu cũ', async () => {
    await patch(admin, { feedLayout: 'feed' }).expect(200)
    expect(await layoutOf(admin)).toBe('feed')
  })
})

describe('Nội quy nhóm — đường ghi từng bị bỏ sót', () => {
  /**
   * SDK client sinh từ một spec CÓ `rules`, nhưng schema `.strict()` của BE lại không khai —
   * gửi lên là 400 mà không assertion nào trong suit cũ bắt được, vì không test nào từng ghi
   * `rules` qua HTTP.
   */
  it('quản trị nhóm ghi được nội quy', async () => {
    await patch(admin, { rules: ['Chỉ đăng đồ thật', 'Ghi rõ giá và tình trạng'] }).expect(200)

    const res = await request(app).get(`/api/v1/organizations/profile/${SLUG}`).expect(200)
    expect(res.body.data.rules).toEqual(['Chỉ đăng đồ thật', 'Ghi rõ giá và tình trạng'])
  })

  /** Mảng rỗng = XOÁ HẾT. Không phân biệt được với "không gửi" thì không có đường gỡ nội quy. */
  it('mảng rỗng xoá sạch nội quy, khác hẳn không gửi field', async () => {
    await patch(admin, { rules: [] }).expect(200)
    const cleared = await request(app).get(`/api/v1/organizations/profile/${SLUG}`).expect(200)
    expect(cleared.body.data.rules).toEqual([])

    // Không gửi `rules` thì giữ nguyên — ở đây là giữ nguyên mảng rỗng vừa đặt.
    await patch(admin, { description: 'Mô tả mới' }).expect(200)
    const kept = await request(app).get(`/api/v1/organizations/profile/${SLUG}`).expect(200)
    expect(kept.body.data.rules).toEqual([])
    expect(kept.body.data.description).toBe('Mô tả mới')
  })

  it('quá 10 dòng nội quy bị chặn', async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `Điều ${i + 1}`)
    const res = await patch(admin, { rules: tooMany })
    expect(res.status).toBe(400)
  })
})
