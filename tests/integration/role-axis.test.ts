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
  grantRole,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let categoryId: string
let otherCategoryId: string

/**
 * BẤT BIẾN: MỘT NGƯỜI, MỘT TRỤC — quản trị nhóm và phụ trách danh mục loại trừ nhau.
 *
 * Bộ test này khoá cả HAI đường tạo grant, vì chúng không đi qua nhau:
 *  - `POST /role-grants` (`roleGrantService.grant`)
 *  - `POST /organizations/:id/admin` (`organizationService.grantAdmin`, gọi thẳng repository)
 *
 * Chặn một đường mà quên đường kia là chốt vô nghĩa — và đường thứ hai lại chính là nơi một
 * người phụ trách danh mục dễ được trao thêm nhóm nhất.
 */
beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  categoryId = await createCategory('Đồ dùng', 'do-dung')
  otherCategoryId = await createCategory('Xe cộ', 'xe-co')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

let seq = 0
const someone = (name: string) => registerUser(app, `u${(seq += 1)}@axis.local`, name)

/** Org mới mỗi ca: các ca dưới đây trao quyền, dùng chung một org là ca sau ăn theo ca trước. */
const orgWith = (key: string, admin: TestUser) =>
  createOrg(app, master.token, { name: `Nhóm ${key}`, key, ownerEmail: admin.email })

const postGrant = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/role-grants').set(bearer(master)).send(body)

const postOrgAdmin = (orgId: string, email: string) =>
  request(app).post(`/api/v1/organizations/${orgId}/admin`).set(bearer(master)).send({ email })

describe('Một người, một trục duyệt', () => {
  it('đang phụ trách danh mục thì không nhận thêm quyền quản trị nhóm', async () => {
    const holder = await someone('Người danh mục')
    // Dựng grant nền bằng model, KHÔNG qua API: ca này kiểm lượt cấp THỨ HAI bị chặn, nên lượt
    // đầu phải vào được dù chính chốt đang test sẽ cấm nó nếu đi đường API.
    await grantRole({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId,
      provinceCodes: ['Hồ Chí Minh'],
    })

    const owner = await someone('Chủ nhóm')
    const org = await orgWith('axis-a', owner)

    const res = await postGrant({
      userId: holder.id,
      role: 'manager',
      scopeType: 'org',
      orgId: org.id,
    })

    expect(res.status).toBe(409)
    // Thông điệp phải nêu VAI ĐANG GIỮ, không chỉ "không được": master cần biết phải thu hồi gì.
    expect(res.body.message).toMatch(/phụ trách danh mục/)
  })

  it('đang là quản trị nhóm thì không nhận thêm quyền danh mục', async () => {
    const holder = await someone('Người của nhóm')
    const org = await orgWith('axis-b', holder)

    const res = await postGrant({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId,
      provinceCodes: ['Hà Nội'],
    })

    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/quản trị nhóm/)
  })

  /*
   * Đường thứ hai, và là đường dễ quên nhất — nó không đi qua `roleGrantService` chút nào.
   *
   * Kiểm luôn MEMBERSHIP không bị đổi: `grantAdmin` nâng người này lên `admin` của nhóm TRƯỚC
   * khi tạo grant, nên chốt đặt sai chỗ sẽ để lại một admin trong danh bạ mà không có quyền
   * duyệt nào — hỏng nửa vời, và không có gì dọn.
   */
  it('đường trao quyền nhóm cũng bị chặn, và KHÔNG đổi danh bạ nhóm', async () => {
    const holder = await someone('Người danh mục 2')
    await grantRole({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: otherCategoryId,
      provinceCodes: ['Đà Nẵng'],
    })

    const owner = await someone('Chủ nhóm 2')
    const org = await orgWith('axis-c', owner)

    const res = await postOrgAdmin(org.id, holder.email)
    expect(res.status).toBe(409)

    const { Membership } = await import('../../src/features/membership/membership.model')
    const membership = await Membership.findOne({
      userId: holder.id,
      organizationId: org.id,
    })
      .lean()
      .exec()
    expect(membership).toBeNull()
  })

  it('thu hồi trục cũ rồi giao trục kia thì ĐƯỢC — đây là đường đi hợp lệ', async () => {
    const holder = await someone('Người đổi trục')
    const org = await orgWith('axis-d', holder)

    const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
    const orgGrant = await RoleGrant.findOne({
      userId: holder.id,
      scopeType: 'org',
      revokedAt: null,
    }).exec()
    expect(orgGrant).not.toBeNull()

    // Thu hồi qua API để đi đúng mọi chốt của `revoke` — org này còn chủ khác nên không đụng
    // bất biến "quản trị cuối cùng"... trừ khi chính họ là người duy nhất, nên trao cho người
    // khác trước.
    const successor = await someone('Người kế nhiệm')
    await postOrgAdmin(org.id, successor.email).expect(200)
    await request(app)
      .delete(`/api/v1/role-grants/${orgGrant!._id.toString()}`)
      .set(bearer(master))
      .expect(200)

    const res = await postGrant({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId,
      provinceCodes: ['Cần Thơ'],
    })
    expect(res.status).toBe(201)
  })

  it('nhiều quyền CÙNG một trục vẫn cấp được — chốt không chặn nhầm', async () => {
    const holder = await someone('Người hai danh mục')
    await grantRole({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId,
      provinceCodes: ['Nghệ An'],
    })

    const res = await postGrant({
      userId: holder.id,
      role: 'manager',
      scopeType: 'category_province',
      categoryId: otherCategoryId,
      provinceCodes: ['Nghệ An'],
    })
    expect(res.status).toBe(201)
  })

  it('mỗi scope thuộc đúng một trục, `system` đứng ngoài cả hai', async () => {
    const { axisOf } = await import('../../src/common/constants')

    expect(axisOf('org')).toBe('org')
    expect(axisOf('org_unit')).toBe('org')
    expect(axisOf('category_province')).toBe('category')
    expect(axisOf('category_ward')).toBe('category')
    // Master phủ cả hai bàn theo thiết kế — xếp `system` vào một trục là tự khoá chính vai
    // vận hành hệ thống.
    expect(axisOf('system')).toBeNull()
  })

  /*
   * Người giữ grant `system` vẫn nhận được quyền trục.
   *
   * Gọi thẳng `assertSingleAxis` chứ không đi qua HTTP: đường API còn một chốt khác — không ai
   * tự cấp quyền cho chính mình — nên một lượt gọi qua đó trả 403 vì lý do chẳng liên quan gì
   * tới trục, và test sẽ xanh/đỏ vì nhầm nguyên nhân.
   */
  it('grant hệ thống không chặn lượt cấp quyền trục', async () => {
    const holder = await someone('Người hệ thống')
    await grantRole({ userId: holder.id, role: 'master', scopeType: 'system' })

    const { assertSingleAxis } = await import('../../src/features/role-grant/role-grant.service')
    await expect(assertSingleAxis(holder.id, 'category_province')).resolves.toBeUndefined()
  })
})
