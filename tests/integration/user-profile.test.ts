import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let seller: TestUser
let orgId = ''
let categoryId = ''

const SLUG = 'profile-org'
const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@profile.local', 'Chủ tổ chức')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Trường Hồ Sơ',
      slug: SLUG,
      ownerEmail: owner.email,
      provinceCode: 'Hồ Chí Minh',
    })
  ).id

  seller = await registerUser(app, 'seller@profile.local', 'Người bán')
  await addMember(seller.id, orgId)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Mặc định của hồ sơ mới', () => {
  it('giới tính "không nêu" và KHÔNG cho hiện số điện thoại', async () => {
    const res = await request(app).get('/api/v1/users/me').set(bearer(seller)).expect(200)

    // Hai mặc định này là quyết định về quyền riêng tư, không phải tiện tay chọn: im lặng công
    // khai SĐT hoặc ép khai giới tính đều là thứ người dùng không hề đồng ý.
    expect(res.body.data).toMatchObject({ gender: 'undisclosed', showPhone: false })
    expect(res.body.data.location).toBeUndefined()
  })
})

describe('Cập nhật hồ sơ', () => {
  it('lưu được giới tính, khu vực, và công tắc SĐT', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({
        phone: '0901234567',
        gender: 'female',
        showPhone: true,
        location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành', address: '12 Lê Lợi' },
      })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      gender: 'female',
      showPhone: true,
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành', address: '12 Lê Lợi' },
    })
  })

  it('xã không thuộc tỉnh thì 400 — không để form đăng tin điền sẵn một cái xã không tồn tại', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ location: { province: 'Hà Nội', ward: 'Phường Bến Thành' } })

    expect(res.status).toBe(400)
  })

  /**
   * Ca này từng là lỗi chặn cả tính năng: `phone: z.string().min(8)` từ chối chuỗi rỗng, mà form
   * hồ sơ luôn gửi `phone` (rỗng khi người dùng chưa đặt số). Hệ quả là tài khoản chưa có SĐT
   * không lưu được BẤT KỲ field nào khác — đổi tên cũng ăn 400.
   */
  it('gửi phone rỗng vẫn lưu được các field khác, và nó XOÁ số cũ', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ name: 'Người bán đổi tên', phone: '' })

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Người bán đổi tên')
    expect(res.body.data.phone).toBe('')

    // Dựng lại số cho các test sau — chúng dựa vào nó.
    await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ phone: '0901234567' })
      .expect(200)
  })

  it('gửi location rỗng thì XOÁ khu vực đã lưu', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ location: {} })

    expect(res.status).toBe(200)
    expect(res.body.data.location?.province).toBeUndefined()

    await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' } })
      .expect(200)
  })

  it('field lạ bị chặn, không lưu lặng lẽ', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ ratingAvg: 5 })

    expect(res.status).toBe(400)
  })
})

/**
 * Chốt quan trọng nhất của cả file: `location` là dữ liệu RIÊNG TƯ. Địa chỉ nhà công khai trên
 * chợ đồ cũ là rủi ro an toàn cho người bán, nên nó không được lọt vào `PublicProfile` dù
 * `toMeProfileDto` có spread `toPublicProfileDto`.
 */
describe('Hồ sơ công khai chỉ lộ đúng phần được phép', () => {
  it('có giới tính, KHÔNG có khu vực / email / SĐT', async () => {
    const res = await request(app).get(`/api/v1/users/${seller.id}`).expect(200)

    expect(res.body.data.gender).toBe('female')
    expect(res.body.data.location).toBeUndefined()
    expect(res.body.data.email).toBeUndefined()
    expect(res.body.data.phone).toBeUndefined()
    expect(res.body.data.showPhone).toBeUndefined()
  })
})

describe('Công tắc SĐT quyết định `posterContact` của tin mới', () => {
  it('bật công tắc thì tin mang số điện thoại', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(seller.token, SLUG))
      .send(listingPayload('Bàn học cũ còn tốt', categoryId))

    expect(res.status).toBe(201)
    expect(res.body.data.posterContact).toBe('0901234567')
  })

  it('tắt công tắc thì tin KHÔNG mang số điện thoại, dù hồ sơ vẫn lưu số đó', async () => {
    await request(app)
      .patch('/api/v1/users/me')
      .set(bearer(seller))
      .send({ showPhone: false })
      .expect(200)

    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(seller.token, SLUG))
      .send(listingPayload('Ghế gỗ hai cái', categoryId))

    expect(res.status).toBe(201)
    expect(res.body.data.posterContact).toBe('')

    // SĐT vẫn còn trong hồ sơ — công tắc chỉ quyết định có công khai hay không, không phải xoá.
    const me = await request(app).get('/api/v1/users/me').set(bearer(seller)).expect(200)
    expect(me.body.data.phone).toBe('0901234567')
  })
})

/**
 * Xoá tài khoản là thao tác CÓ HỆ QUẢ, không phải một cột `deletedAt`.
 *
 * Bản trước chỉ tắt tài khoản: membership vẫn `active` nên người đã xoá còn nằm trong danh bạ
 * org, và role_grant vẫn hiệu lực nên chốt "luôn còn ít nhất một master" — vốn đếm GRANT —
 * vẫn báo ổn trong khi không master nào đăng nhập được nữa.
 */
describe('Xoá tài khoản kéo theo quyền và tư cách thành viên', () => {
  it('membership bị lưu trữ và role_grant bị thu hồi', async () => {
    const { grantRole } = await import('../helpers/fixtures')
    const { Membership } = await import('../../src/features/membership/membership.model')
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')

    const victim = await registerUser(app, 'victim@profile.local', 'Người rời đi')
    await addMember(victim.id, orgId)
    await grantRole({ userId: victim.id, role: 'staff', scopeType: 'org', orgId })

    await request(app).delete('/api/v1/users/me').set(bearer(victim)).expect(200)

    expect(await Membership.countDocuments({ userId: victim.id, status: 'active' })).toBe(0)
    expect(await RoleGrant.countDocuments({ userId: victim.id, revokedAt: null })).toBe(0)
  })

  it('master cuối cùng không tự xoá được', async () => {
    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')

    const res = await request(app).delete('/api/v1/users/me').set(bearer(master))
    expect(res.status).toBe(409)

    // Chặn xong phải KHÔNG để lại dấu vết: grant còn nguyên thì lần sau vẫn cấp quyền được.
    expect(await RoleGrant.countDocuments({ role: 'master', revokedAt: null })).toBe(1)
    await request(app).get('/api/v1/users/me').set(bearer(master)).expect(200)
  })
})
