import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, makeMaster, registerUser, startTestDb } from '../helpers/fixtures'
import { walletService } from '../../src/features/wallet/wallet.service'
import { walletRepository } from '../../src/features/wallet/wallet.repository'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser

const asMaster = () => ({ Authorization: `Bearer ${master.token}` })
const asOwner = () => ({ Authorization: `Bearer ${owner.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@wallet.local', 'Chủ ví')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Ví Xu — đọc', () => {
  it('ví chưa từng giao dịch trả về 0, không phải 404', async () => {
    const res = await request(app).get('/api/v1/wallet').set(asOwner()).expect(200)
    expect(res.body.data).toEqual({ balance: 0, currency: 'xu' })
  })

  it('chưa đăng nhập thì không xem được ví', async () => {
    await request(app).get('/api/v1/wallet').expect(401)
  })
})

describe('Ví Xu — master cộng/trừ tay', () => {
  it('cộng Xu: số dư lên, sổ cái có dòng kèm lý do, người nhận được báo', async () => {
    const res = await request(app)
      .post(`/api/v1/wallet/${owner.id}/adjust`)
      .set(asMaster())
      .send({ amount: 100, note: 'Tặng Xu khai trương', idempotencyKey: 'grant-khai-truong-1' })
      .expect(200)

    expect(res.body.data).toMatchObject({ amount: 100, type: 'admin_adjust', balanceAfter: 100 })

    const wallet = await request(app).get('/api/v1/wallet').set(asOwner()).expect(200)
    expect(wallet.body.data.balance).toBe(100)

    const history = await request(app).get('/api/v1/wallet/transactions').set(asOwner()).expect(200)
    expect(history.body.data[0]).toMatchObject({ amount: 100, note: 'Tặng Xu khai trương' })

    const inbox = await request(app).get('/api/v1/notifications').set(asOwner()).expect(200)
    expect(inbox.body.data.some((n: { title: string }) => n.title === 'Ví Xu vừa được cộng')).toBe(
      true,
    )
  }, 60_000)

  it('GỌI LẠI cùng idempotencyKey KHÔNG cộng đôi — đây là thứ giữ tiền của khách', async () => {
    await request(app)
      .post(`/api/v1/wallet/${owner.id}/adjust`)
      .set(asMaster())
      .send({ amount: 100, note: 'Tặng Xu khai trương', idempotencyKey: 'grant-khai-truong-1' })
      .expect(200)

    const wallet = await request(app).get('/api/v1/wallet').set(asOwner()).expect(200)
    expect(wallet.body.data.balance).toBe(100)
  }, 60_000)

  it('trừ quá số dư → 402, và số dư KHÔNG bị sứt mẻ gì', async () => {
    const res = await request(app)
      .post(`/api/v1/wallet/${owner.id}/adjust`)
      .set(asMaster())
      .send({ amount: -500, note: 'Thu hồi quá tay', idempotencyKey: 'thu-hoi-qua-tay' })

    expect(res.status).toBe(402)

    const wallet = await request(app).get('/api/v1/wallet').set(asOwner()).expect(200)
    expect(wallet.body.data.balance).toBe(100)

    // Transaction cuốn ngược sạch: không có dòng sổ nào được ghi cho lượt hỏng này.
    expect(await walletRepository.findByIdempotencyKey('adjust:thu-hoi-qua-tay')).toBeNull()
  }, 60_000)

  it('amount 0 bị chặn — một dòng sổ không đổi gì là rác', async () => {
    await request(app)
      .post(`/api/v1/wallet/${owner.id}/adjust`)
      .set(asMaster())
      .send({ amount: 0, note: 'Không làm gì cả', idempotencyKey: 'zero-op' })
      .expect(400)
  })

  it('người thường không tự cộng Xu cho mình', async () => {
    await request(app)
      .post(`/api/v1/wallet/${owner.id}/adjust`)
      .set(asOwner())
      .send({ amount: 1000, note: 'Tự thưởng', idempotencyKey: 'tu-thuong' })
      .expect(403)
  })
})

describe('Ví Xu — bất biến của sổ cái', () => {
  it('số dư LUÔN bằng tổng sổ cái, kể cả sau một loạt biến động và một lượt hỏng', async () => {
    const user = await registerUser(app, 'ledger@wallet.local', 'Người đối soát')
    const userId = new Types.ObjectId(user.id)

    await walletService.apply({ userId, amount: 50, type: 'topup', idempotencyKey: 'l-1' })
    await walletService.apply({ userId, amount: 30, type: 'promo_grant', idempotencyKey: 'l-2' })
    await walletService.apply({ userId, amount: -20, type: 'post_fee', idempotencyKey: 'l-3' })
    await walletService.apply({ userId, amount: 20, type: 'refund', idempotencyKey: 'l-4' })
    // Lượt hỏng phải không để lại dấu vết nào.
    await expect(
      walletService.apply({ userId, amount: -999, type: 'post_fee', idempotencyKey: 'l-5' }),
    ).rejects.toThrow()

    const balance = await walletService.balanceOf(userId)
    expect(balance).toBe(80)
    expect(await walletRepository.ledgerSum(userId)).toBe(80)
  }, 60_000)

  it('mười lượt chi song song cùng lúc: không lượt nào lọt qua khi hết tiền', async () => {
    const user = await registerUser(app, 'race@wallet.local', 'Người chi song song')
    const userId = new Types.ObjectId(user.id)
    await walletService.apply({ userId, amount: 50, type: 'topup', idempotencyKey: 'race-topup' })

    // 10 lượt × 10 Xu trên số dư 50 — đúng 5 lượt được đi qua, không hơn.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        walletService.apply({
          userId,
          amount: -10,
          type: 'post_fee',
          idempotencyKey: `race-spend-${i}`,
        }),
      ),
    )

    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(ok).toBe(5)
    expect(await walletService.balanceOf(userId)).toBe(0)
    expect(await walletRepository.ledgerSum(userId)).toBe(0)
  }, 60_000)
})
