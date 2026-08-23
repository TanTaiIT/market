import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import {
  CleanupConfig,
  uploadCleanupService,
} from '../../src/features/upload/upload.cleanup.service'

let app: Application
let mongod: MongoMemoryReplSet
let seller: TestUser

const CLOUD = 'test-cloud'
const cfg: CleanupConfig = {
  cloudName: CLOUD,
  apiKey: 'key',
  apiSecret: 'secret',
  folder: 'ghim',
}

const url = (id: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${id}.jpg`

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const categoryId = await createCategory('Đồ dùng', 'do-dung')
  const master = await makeMaster(app)
  seller = await registerUser(app, 'seller@cleanup.local', 'Người bán')
  await createOrg(app, master.token, {
    name: 'Org dọn ảnh',
    slug: 'don-anh',
    ownerEmail: seller.email,
  })

  // Một tin thật giữ 2 ảnh + avatar user — nguồn "còn chủ" cho các test bên dưới.
  await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, 'don-anh'))
    .send({
      title: 'Tin giữ ảnh trên cloud',
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: [url('ghim/keep-1'), url('ghim/keep-2')],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    .expect(201)

  await request(app)
    .patch('/api/v1/users/me')
    .set({ Authorization: `Bearer ${seller.token}` })
    .send({ avatar: url('ghim/keep-avatar') })
    .expect(200)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

afterEach(() => vi.unstubAllGlobals())

/** Giả lập Cloudinary: search trả danh sách cho trước, delete ghi lại những gì bị xoá. */
function stubCloudinary(staleIds: string[]) {
  const deleted: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const u = String(input)
      if (u.includes('/resources/search')) {
        return new Response(
          JSON.stringify({ resources: staleIds.map((public_id) => ({ public_id })) }),
          { status: 200 },
        )
      }
      if (u.includes('/resources/image/upload')) {
        const ids = [...new URL(u).searchParams.getAll('public_ids[]')]
        deleted.push(...ids)
        return new Response(
          JSON.stringify({ deleted: Object.fromEntries(ids.map((i) => [i, 'deleted'])) }),
          { status: 200 },
        )
      }
      throw new Error(`fetch không mong đợi: ${u}`)
    }),
  )
  return deleted
}

describe('Job dọn ảnh mồ côi', () => {
  it('xoá đúng ảnh không ai tham chiếu, giữ nguyên ảnh của tin và avatar', async () => {
    const deleted = stubCloudinary([
      'ghim/keep-1',
      'ghim/keep-2',
      'ghim/keep-avatar',
      'ghim/orphan-1',
      'ghim/orphan-2',
    ])

    const result = await uploadCleanupService.sweep(cfg)

    expect(result).toEqual({ scanned: 5, orphans: 2, deleted: 2 })
    expect(deleted.sort()).toEqual(['ghim/orphan-1', 'ghim/orphan-2'])
  }, 60_000)

  it('kho sạch — không lệnh xoá nào được gọi', async () => {
    const deleted = stubCloudinary(['ghim/keep-1', 'ghim/keep-avatar'])

    const result = await uploadCleanupService.sweep(cfg)

    expect(result).toEqual({ scanned: 2, orphans: 0, deleted: 0 })
    expect(deleted).toEqual([])
  }, 60_000)

  it('thiếu cấu hình CLOUDINARY_* — job tự tắt, không chạm mạng', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadCleanupService.sweep(null)

    expect(result).toEqual({ scanned: 0, orphans: 0, deleted: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
