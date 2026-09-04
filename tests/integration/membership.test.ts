import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  makeMaster,
  grantRole,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { INITIAL_TRUST } from '../../src/features/trust/trust.policy'

let app: Application
let mongod: MongoMemoryReplSet

let owner: TestUser
let member: TestUser
let master: TestUser
let orgId = ''
let otherOwner: TestUser

const SLUG = 'roster-a'
const OTHER_SLUG = 'roster-b'

const members = (token: string, slug: string) =>
  request(app).get('/api/v1/memberships').set(orgAuth(token, slug))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@roster.local', 'Chủ tổ chức')
  const org = await createOrg(app, master.token, {
    name: 'Trường Roster',
    slug: SLUG,
    // 'school' mới có `capabilities.hasUnits` — nhóm con là thứ ca cuối cùng cần tới.
    orgType: 'school',
    ownerEmail: owner.email,
  })

  orgId = org.id
  member = await registerUser(app, 'member@roster.local', 'Thành viên roster')
  await addMember(member.id, org.id)

  otherOwner = await registerUser(app, 'owner@roster-b.local', 'Chủ tổ chức B')
  const otherOrg = await createOrg(app, master.token, {
    name: 'Trường Roster B',
    slug: OTHER_SLUG,
    ownerEmail: otherOwner.email,
  })
  const otherMember = await registerUser(app, 'member@roster-b.local', 'Thành viên B')
  await addMember(otherMember.id, otherOrg.id)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('GET /memberships', () => {
  it('trả đủ danh bạ, chủ tổ chức đứng đầu', async () => {
    const res = await members(owner.token, SLUG).expect(200)

    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual([
      'Chủ tổ chức',
      'Thành viên roster',
    ])
    expect(res.body.meta.total).toBe(2)
  })

  /**
   * Ca chính khiến endpoint này phải tồn tại: chủ tổ chức do master chỉ định KHÔNG có đơn gia
   * nhập nào, nên bản roster suy từ `/join-requests?status=approved` bỏ sót đúng người quan
   * trọng nhất của org.
   */
  it('có cả người không đi qua đơn gia nhập', async () => {
    const res = await members(owner.token, SLUG).expect(200)
    const chu = res.body.data.find((m: { name: string }) => m.name === 'Chủ tổ chức')

    // Tài khoản mới đứng ở bậc trần: danh bạ phải nói đúng thế, không phải bậc 0 của mô hình cũ.
    expect(chu).toMatchObject({
      role: 'admin',
      unitId: null,
      trustLevel: INITIAL_TRUST.level,
    })
    expect(chu.userId).toBe(owner.id)
    expect(chu.joinedAt).toEqual(expect.any(String))
  })

  /**
   * Master không phải thành viên của org nào — `createOrg` chỉ định chủ tổ chức chứ không tự
   * ghi master vào roster. Chặn họ đọc danh bạ là dựng ra một bàn quản trị mà người quản xoá
   * được thành viên (`DELETE` dùng `requireOrgAdmin`) nhưng không nhìn được mình đang xoá ai.
   */
  it('master không thuộc org vẫn đọc được danh bạ', async () => {
    const res = await members(master.token, SLUG).expect(200)

    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual([
      'Chủ tổ chức',
      'Thành viên roster',
    ])
  })

  /** Nới cho người QUẢN org này, không nới cho người ngoài: chủ org B không quản gì ở org A. */
  it('chủ tổ chức khác vẫn bị chặn — nới cổng không phải mở cổng', async () => {
    await members(otherOwner.token, SLUG).expect(403)
  })

  it('KHÔNG trả email/phone — danh bạ để nhận ra người, không phải bản sao hồ sơ', async () => {
    const res = await members(owner.token, SLUG).expect(200)
    const keys = Object.keys(res.body.data[0]).sort()

    expect(keys).toEqual([
      'avatar',
      'joinedAt',
      'joinedVia',
      'name',
      'role',
      'trustLevel',
      'unitId',
      'userId',
    ])
  })

  it('mỗi org chỉ thấy người của mình', async () => {
    const res = await members(otherOwner.token, OTHER_SLUG).expect(200)
    const names = res.body.data.map((m: { name: string }) => m.name)

    expect(names).toContain('Chủ tổ chức B')
    expect(names).not.toContain('Thành viên roster')
  })

  it('thành viên thường CŨNG xem được, nhưng bản rút gọn', async () => {
    const res = await members(member.token, SLUG).expect(200)

    // Nhóm thì phải thấy nhau. Ba field hồ sơ vận hành thì không — bậc uy tín là kết luận của
    // bàn duyệt về một người, không phải thông tin để cả nhóm bình phẩm.
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      'avatar',
      'name',
      'role',
      'unitId',
      'userId',
    ])
    expect(res.body.data.map((m: { name: string }) => m.name)).toContain('Chủ tổ chức')
  })

  it('chưa đăng nhập → 401', async () => {
    await request(app).get('/api/v1/memberships').expect(401)
  })
})

/**
 * Quản lý thành viên — trước bản này BE chỉ có ĐÚNG MỘT route `GET /memberships`.
 *
 * Vào nhóm có ba đường (duyệt đơn, nhận lời mời, master trao quyền chủ), nhưng ra khỏi nhóm thì
 * chỉ có xoá tài khoản. Đây là nửa còn thiếu của vòng đời.
 */
describe('Quản trị nhóm quản lý thành viên', () => {
  const asOwner = () => orgAuth(owner.token, SLUG)

  it('gỡ được một thành viên thường — họ biến khỏi danh bạ', async () => {
    const leaving = await registerUser(app, 'se-bi-go@roster.local', 'Người sẽ bị gỡ')
    await addMember(leaving.id, orgId)

    const before = await request(app).get('/api/v1/memberships').set(asOwner()).expect(200)
    expect(before.body.data.map((m: { userId: string }) => m.userId)).toContain(leaving.id)

    await request(app).delete(`/api/v1/memberships/${leaving.id}`).set(asOwner()).expect(200)

    const after = await request(app).get('/api/v1/memberships').set(asOwner()).expect(200)
    expect(after.body.data.map((m: { userId: string }) => m.userId)).not.toContain(leaving.id)
  }, 60_000)

  it('gỡ người đã không còn trong nhóm → 404, không phải báo thành công', async () => {
    const stranger = await registerUser(app, 'nguoi-la@roster.local', 'Người lạ')

    await request(app).delete(`/api/v1/memberships/${stranger.id}`).set(asOwner()).expect(404)
  }, 60_000)

  it('KHÔNG tự gỡ mình — đó là thao tác rời nhóm, hậu quả khác hẳn', async () => {
    await request(app).delete(`/api/v1/memberships/${owner.id}`).set(asOwner()).expect(400)
  }, 60_000)

  it('KHÔNG gỡ được quản trị khác — nếu không hai người gỡ lẫn nhau, ai bấm trước thắng', async () => {
    const coAdmin = await registerUser(app, 'dong-quan-tri@roster.local', 'Đồng quản trị')

    await addMember(coAdmin.id, orgId)
    await grantRole({ userId: coAdmin.id, role: 'manager', scopeType: 'org', orgId })

    await request(app).delete(`/api/v1/memberships/${coAdmin.id}`).set(asOwner()).expect(403)

    // Master là đường sửa sai cuối cùng — họ đứng ngoài chốt này.
    await request(app)
      .delete(`/api/v1/memberships/${coAdmin.id}`)
      .set(orgAuth(master.token, SLUG))
      .expect(200)
  }, 60_000)

  it('thành viên thường KHÔNG gỡ được ai', async () => {
    const victim = await registerUser(app, 'nan-nhan@roster.local', 'Nạn nhân')
    await addMember(victim.id, orgId)

    await request(app)
      .delete(`/api/v1/memberships/${victim.id}`)
      .set(orgAuth(member.token, SLUG))
      .expect(403)
  }, 60_000)
})
