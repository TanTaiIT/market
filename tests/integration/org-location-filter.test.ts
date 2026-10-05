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
  orgIdOf,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * Bộ lọc tỉnh/phường của màn "Tìm nhóm" và field `ward` của nhóm.
 *
 * Phường theo DANH MỤC ĐÓNG (cùng nguồn với tin đăng), không phải chữ tự do như `district` cũ:
 * lọc được là nhờ so khớp chính xác, nên đường ghi phải chặn mọi phường không thuộc tỉnh.
 */
let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let owner: TestUser

const HCM_BEN_THANH = 'nhom-ben-thanh'
const HCM_NO_WARD = 'nhom-hcm-chua-khai'
const HANOI = 'nhom-ha-noi'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
const lookup = (query: Record<string, string>) =>
  request(app).get('/api/v1/organizations/lookup').query(query)
const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((o) => o.name)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@location.local', 'Chủ nhóm')

  await createOrg(app, master.token, {
    name: 'Chợ sách Bến Thành',
    key: HCM_BEN_THANH,
    ownerEmail: owner.email,
    provinceCode: 'Hồ Chí Minh',
    ward: 'Phường Bến Thành',
  })
  await createOrg(app, master.token, {
    name: 'Chợ sách Sài Gòn',
    key: HCM_NO_WARD,
    ownerEmail: owner.email,
    provinceCode: 'Hồ Chí Minh',
  })
  await createOrg(app, master.token, {
    name: 'Chợ sách Ba Đình',
    key: HANOI,
    ownerEmail: owner.email,
    provinceCode: 'Hà Nội',
    ward: 'Phường Ba Đình',
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Tìm nhóm — lọc theo tỉnh / phường', () => {
  it('không lọc: đủ ba nhóm', async () => {
    const res = await lookup({ q: 'chợ sách' }).expect(200)
    expect(names(res).sort()).toEqual(
      ['Chợ sách Ba Đình', 'Chợ sách Bến Thành', 'Chợ sách Sài Gòn'].sort(),
    )
  })

  it('lọc tỉnh: chỉ nhóm của tỉnh đó, kể cả nhóm chưa khai phường', async () => {
    const res = await lookup({ q: 'chợ sách', province: 'Hồ Chí Minh' }).expect(200)
    expect(names(res).sort()).toEqual(['Chợ sách Bến Thành', 'Chợ sách Sài Gòn'].sort())
  })

  it('lọc tỉnh + phường: đúng nhóm ở phường đó; từ khoá trống cũng lọc được', async () => {
    const res = await lookup({ province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' }).expect(200)
    expect(names(res)).toEqual(['Chợ sách Bến Thành'])
  })

  it('DTO trả `ward` để thẻ nhóm hiện địa bàn', async () => {
    const res = await lookup({ province: 'Hà Nội' }).expect(200)
    expect(res.body.data[0]).toMatchObject({ provinceCode: 'Hà Nội', ward: 'Phường Ba Đình' })
  })

  it('phường không kèm tỉnh, hoặc phường không thuộc tỉnh → 400 (không lặng lẽ trả rỗng)', async () => {
    await lookup({ ward: 'Phường Bến Thành' }).expect(400)
    await lookup({ province: 'Hà Nội', ward: 'Phường Bến Thành' }).expect(400)
  })

  it('tỉnh ngoài danh mục → 400', async () => {
    await lookup({ province: 'Sài Gòn' }).expect(400)
  })

  it('gõ MÃ thì ra đúng nhóm đó, bất kể bộ lọc đang để tỉnh khác', async () => {
    const code = await joinCodeOf(HANOI)
    const res = await lookup({ q: code, province: 'Hồ Chí Minh' }).expect(200)
    expect(names(res)).toEqual(['Chợ sách Ba Đình'])
  })
})

describe('Master tạo nhóm kèm phường', () => {
  it('phường không thuộc tỉnh → 400', async () => {
    await request(app)
      .post('/api/v1/organizations')
      .set(bearer(master))
      .send({ name: 'Nhóm sai địa bàn', provinceCode: 'Hà Nội', ward: 'Phường Bến Thành' })
      .expect(400)
  })

  it('phường không kèm tỉnh → 400', async () => {
    await request(app)
      .post('/api/v1/organizations')
      .set(bearer(master))
      .send({ name: 'Nhóm thiếu tỉnh', ward: 'Phường Bến Thành' })
      .expect(400)
  })
})

describe('Quản trị nhóm chọn phường ở hồ sơ nhóm', () => {
  const asOwner = (key: string) => ({ ...bearer(owner), 'X-Org-Id': orgIdOf(key) })

  it('chọn phường thuộc tỉnh của nhóm → lưu, và bộ lọc thấy ngay', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(asOwner(HCM_NO_WARD))
      .send({ ward: 'Phường Sài Gòn' })
    expect(res.status).toBe(200)

    const found = await lookup({ province: 'Hồ Chí Minh', ward: 'Phường Sài Gòn' }).expect(200)
    expect(names(found)).toEqual(['Chợ sách Sài Gòn'])
  })

  it('phường của tỉnh KHÁC → 400, giữ nguyên phường cũ', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(asOwner(HCM_BEN_THANH))
      .send({ ward: 'Phường Ba Đình' })
      .expect(400)

    const profile = await request(app)
      .get(`/api/v1/organizations/profile/${orgIdOf(HCM_BEN_THANH)}`)
      .expect(200)
    expect(profile.body.data.ward).toBe('Phường Bến Thành')
  })

  it('gửi `null` → gỡ phường', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(asOwner(HANOI))
      .send({ ward: null })
      .expect(200)

    const res = await lookup({ province: 'Hà Nội', ward: 'Phường Ba Đình' }).expect(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('tỉnh vẫn KHÔNG sửa được ở đây — nó do master đặt', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(asOwner(HANOI))
      .send({ provinceCode: 'Hồ Chí Minh' })
      .expect(400)
  })
})
