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
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { Organization } from '../../src/features/organization/organization.model'
import { organizationRepository } from '../../src/features/organization/organization.repository'

/**
 * `Organization` từng là model có `deletedAt` duy nhất KHÔNG có hook soft-delete (audit 5.6):
 * repository tự lọc từng query, và method mới nhất đã quên. Hook ở model là chỗ không ai phải nhớ.
 */
let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let deletedId = ''
let liveId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)

  const ownerA = await registerUser(app, 'owner-a@sd.local', 'Chủ A')
  const ownerB = await registerUser(app, 'owner-b@sd.local', 'Chủ B')
  deletedId = (
    await createOrg(app, master.token, {
      name: 'Nhóm đã xoá',
      key: 'sd-deleted',
      ownerEmail: ownerA.email,
    })
  ).id
  liveId = (
    await createOrg(app, master.token, {
      name: 'Nhóm còn sống',
      key: 'sd-live',
      ownerEmail: ownerB.email,
    })
  ).id

  await Organization.updateOne({ _id: deletedId }, { deletedAt: new Date() }).exec()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Org đã xoá mềm biến khỏi mọi đường đọc mặc định', () => {
  it('`find` / `countDocuments` trần trên model cũng không thấy — hook ở model, không ở repository', async () => {
    const ids = (await Organization.find().select('_id').lean().exec()).map((o) => String(o._id))
    expect(ids).toContain(liveId)
    expect(ids).not.toContain(deletedId)
    expect(await Organization.countDocuments({ _id: deletedId }).exec()).toBe(0)
  })

  it('`allImageUrls` — method từng quên lọc — không còn kéo ảnh của org đã xoá', async () => {
    await Organization.updateOne(
      { _id: deletedId },
      { avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/deleted-avatar.jpg' },
    )
      .setOptions({ withDeleted: true })
      .exec()
    const urls = await organizationRepository.allImageUrls()
    expect(urls).not.toContain('https://res.cloudinary.com/demo/image/upload/v1/deleted-avatar.jpg')
  })

  it('hồ sơ công khai và tra theo id đều 404', async () => {
    await request(app).get(`/api/v1/organizations/profile/${deletedId}`).expect(404)
    expect(await organizationRepository.findById(deletedId)).toBeNull()
  })

  it('`withDeleted` vẫn đọc được — hợp đồng chung với các model soft-delete khác', async () => {
    const row = await Organization.findById(deletedId)
      .setOptions({ withDeleted: true })
      .lean()
      .exec()
    expect(row?.deletedAt).not.toBeNull()
  })
})
