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
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let owner: TestUser
let member: TestUser
let otherOwner: TestUser

const SLUG = 'roster-a'
const OTHER_SLUG = 'roster-b'

const members = (token: string, slug: string) =>
  request(app).get('/api/v1/memberships').set(orgAuth(token, slug))

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const master = await makeMaster(app)
  owner = await registerUser(app, 'owner@roster.local', 'Chủ tổ chức')
  const org = await createOrg(app, master.token, {
    name: 'Trường Roster',
    slug: SLUG,
    ownerEmail: owner.email,
  })

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

    expect(chu).toMatchObject({ role: 'owner', unitId: null, trustLevel: 0 })
    expect(chu.userId).toBe(owner.id)
    expect(chu.joinedAt).toEqual(expect.any(String))
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

  it('thành viên thường không có grant → 403', async () => {
    const res = await members(member.token, SLUG)
    expect(res.status).toBe(403)
  })

  it('chưa đăng nhập → 401', async () => {
    await request(app).get('/api/v1/memberships').expect(401)
  })
})
