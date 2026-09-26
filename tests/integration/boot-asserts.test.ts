import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { createTestApp, startTestDb } from '../helpers/fixtures'
import { assertIndexesInSync, assertReplicaSet } from '../../src/config/database'

/**
 * Hai chốt lúc boot (audit 4.2). Chạy trên mongodb-memory-server (replica set, `autoIndex` bật):
 * cả hai phải qua, và ca "index của mọi model khớp DB" cũng là canary cho định nghĩa index
 * trong model — hai index trùng/khai sai sẽ lộ ra ở đây trước khi lên prod.
 */
let mongod: MongoMemoryReplSet

beforeAll(async () => {
  mongod = await startTestDb()
  await createTestApp()
  // `autoIndex` tạo index ở nền sau khi model được compile — chờ xong rồi mới so.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()))
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Chốt lúc boot', () => {
  it('replica set: server test là replset nên qua', async () => {
    await expect(assertReplicaSet()).resolves.toBeUndefined()
  })

  it('index của mọi model đã khớp với DB — không lệch dòng nào', async () => {
    expect(await assertIndexesInSync()).toEqual([])
  })
})
