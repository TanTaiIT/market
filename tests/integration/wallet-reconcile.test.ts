import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { createTestApp, registerUser, startTestDb } from '../helpers/fixtures'
import { walletReconcileService } from '../../src/features/wallet/wallet.reconcile.service'
import { Wallet, XU_TX_TYPES, XuTransaction } from '../../src/features/wallet/wallet.model'

/**
 * Đối soát ví (audit 4.2): `balance` là cache của sổ cái. Khớp thì im, lệch thì NÉM để job báo
 * lên Sentry — không tự sửa vì sửa là đoán bên nào đúng.
 */
let mongod: MongoMemoryReplSet
let userId: mongoose.Types.ObjectId

beforeAll(async () => {
  mongod = await startTestDb()
  const app = await createTestApp()
  const u = await registerUser(app, 'wallet@reconcile.local', 'Chủ ví')
  userId = new mongoose.Types.ObjectId(u.id)

  await Wallet.create({ userId, balance: 300 })
  await XuTransaction.create([
    { userId, amount: 200, type: XU_TX_TYPES[0], balanceAfter: 200, idempotencyKey: 'rc-1' },
    { userId, amount: 100, type: XU_TX_TYPES[0], balanceAfter: 300, idempotencyKey: 'rc-2' },
  ])
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('wallet-reconcile:sweep', () => {
  it('khớp sổ cái thì trả về số ví đã soát, không ném', async () => {
    await expect(walletReconcileService.sweep()).resolves.toEqual({ checked: 1, mismatched: 0 })
  })

  it('có người ghi tắt vào balance → ném kèm số ví lệch', async () => {
    await Wallet.updateOne({ userId }, { $set: { balance: 999 } }).exec()
    await expect(walletReconcileService.sweep()).rejects.toThrow(/1\/1 ví lệch/)
  })
})
