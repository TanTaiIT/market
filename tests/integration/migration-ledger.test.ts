import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { startTestDb } from '../helpers/fixtures'
import { runMigrationOnce } from '../../scripts/migrationLedger'

/**
 * Audit 7.2 — sổ `_migrations`: migration gỡ index / xoá field không phải thứ chạy hai lần được,
 * nên "đã chạy chưa" phải nằm trong DB chứ không trong trí nhớ người vận hành.
 */
let mongod: MongoMemoryReplSet

beforeAll(async () => {
  mongod = await startTestDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
}, 120_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await mongoose.disconnect()
  await mongod.stop()
})

const ledger = () => mongoose.connection.db!.collection('_migrations')

describe('runMigrationOnce', () => {
  it('lần đầu chạy và ghi sổ; lần hai bỏ qua, KHÔNG gọi lại thân migration', async () => {
    const fn = vi.fn(async () => {})

    expect(await runMigrationOnce('thu-nghiem', fn)).toBe('applied')
    expect(await runMigrationOnce('thu-nghiem', fn)).toBe('skipped')
    expect(fn).toHaveBeenCalledTimes(1)

    const row = await ledger().findOne({ name: 'thu-nghiem' })
    expect(row?.appliedAt).toBeInstanceOf(Date)
  })

  it('hỏng giữa chừng → xoá dấu, lượt sau làm lại từ đầu', async () => {
    const boom = vi.fn(async () => {
      throw new Error('mất kết nối giữa chừng')
    })
    await expect(runMigrationOnce('hong-giua-chung', boom)).rejects.toThrow('mất kết nối')
    expect(await ledger().findOne({ name: 'hong-giua-chung' })).toBeNull()

    const ok = vi.fn(async () => {})
    expect(await runMigrationOnce('hong-giua-chung', ok)).toBe('applied')
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('mỗi tên là một sổ riêng', async () => {
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {})
    await runMigrationOnce('mot', a)
    await runMigrationOnce('hai', b)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
