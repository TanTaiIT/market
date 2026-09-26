import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
import { listingRepository } from '../../src/features/listing/listing.repository'

/**
 * Audit 1.18 — hai lỗ "ghi đè im lặng" của tin đăng:
 *
 * 1. Đăng đôi: client mạng chập chờn bấm "Ghim" hai lần → hai tin giống hệt, tốn quota hai lần.
 *    Header `Idempotency-Key` (tuỳ chọn) biến lượt hai thành "trả lại tin cũ".
 * 2. Sửa đè phán quyết: chủ tin sửa đúng lúc người duyệt đổi trạng thái → bản sửa ghi lên sau
 *    và xoá dấu vết phán quyết. Ghi có chốt trạng thái đã đọc; lệch là 409.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let seller: TestUser
let categoryId = ''
const ORG = 'nhom-dang-doi'

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@idem.local', 'Người bán')
  await createOrg(app, master.token, { name: 'Nhóm đăng đôi', key: ORG, ownerEmail: seller.email })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

function post(title: string, key?: string) {
  const req = request(app).post('/api/v1/listings').set(orgAuth(seller.token, ORG))
  if (key) req.set('Idempotency-Key', key)
  return req.send(listingPayload(title, categoryId))
}

async function countMine() {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped('test: đếm tin của người bán', () =>
    Listing.countDocuments({ seller: seller.id }).exec(),
  )
}

describe('Idempotency-Key — chống đăng đôi', () => {
  it('cùng khoá bấm hai lần → cùng MỘT tin, không tốn quota lần hai', async () => {
    const first = await post('Bàn học gỗ thông', 'soan-1').expect(201)
    const again = await post('Bàn học gỗ thông', 'soan-1').expect(201)

    expect(again.body.data._id).toBe(first.body.data._id)
    expect(await countMine()).toBe(1)
  }, 60_000)

  it('khoá khác → tin khác; không gửi khoá → đăng như cũ (client cũ không đổi gì)', async () => {
    const other = await post('Ghế xoay văn phòng', 'soan-2').expect(201)
    expect(other.body.data.title).toBe('Ghế xoay văn phòng')
    expect(await countMine()).toBe(2)

    await post('Kệ sách ba tầng').expect(201)
    expect(await countMine()).toBe(3)
  }, 60_000)

  it('hai request cùng khoá về CÙNG LÚC → vẫn một tin (unique index phân thắng thua)', async () => {
    const [a, b] = await Promise.all([post('Đèn bàn LED', 'soan-3'), post('Đèn bàn LED', 'soan-3')])

    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.body.data._id).toBe(b.body.data._id)
    expect(await countMine()).toBe(4)
  }, 60_000)

  it('khoá của người này KHÔNG mở được tin của người khác', async () => {
    const stranger = await registerUser(app, 'stranger@idem.local', 'Người lạ')
    const res = await request(app)
      .post('/api/v1/listings')
      .set('Authorization', `Bearer ${stranger.token}`)
      .set('Idempotency-Key', 'soan-1')
      .send(listingPayload('Tin của người lạ', categoryId))
      .expect(201)

    expect(res.body.data.title).toBe('Tin của người lạ')
    expect(res.body.data.seller === seller.id).toBe(false)
  }, 60_000)
})

describe('Sửa tin — không đè phán quyết vừa ghi', () => {
  it('trạng thái đổi giữa lúc đọc và ghi → 409, bản sửa bị bỏ', async () => {
    const created = await post('Tủ lạnh mini 90 lít', 'soan-5').expect(201)

    // Giả lập "người duyệt vừa đổi trạng thái": lệnh ghi có chốt không khớp bản nào.
    const spy = vi
      .spyOn(listingRepository, 'updateByIdIfStatus')
      .mockReturnValueOnce({ exec: async () => null } as never)

    const res = await request(app)
      .patch(`/api/v1/listings/${created.body.data._id}`)
      .set(orgAuth(seller.token, ORG))
      .send({ description: 'Mô tả mới đủ dài cho zod schema đi qua được' })
    // Đếm TRƯỚC khi restore: `mockRestore` xoá luôn lịch sử gọi.
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    expect(res.status).toBe(409)
  }, 60_000)

  it('không có ai chen ngang thì sửa như thường', async () => {
    const created = await post('Máy giặt cửa trước', 'soan-6').expect(201)
    const res = await request(app)
      .patch(`/api/v1/listings/${created.body.data._id}`)
      .set(orgAuth(seller.token, ORG))
      .send({ description: 'Mô tả mới đủ dài cho zod schema đi qua được' })
      .expect(200)
    expect(res.body.data.description).toBe('Mô tả mới đủ dài cho zod schema đi qua được')
  }, 60_000)
})
