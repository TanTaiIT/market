import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { unverifiedCleanupService } from '../../src/features/auth/unverified-cleanup.service'
import { env } from '../../src/config/env'
import request from 'supertest'

/**
 * Job dọn tài khoản đăng ký rồi bỏ.
 *
 * Đây là đường DUY NHẤT trong hệ xoá CỨNG một `User`, nên phần lớn test dưới đây không kiểm
 * "có xoá không" mà kiểm "có chừa đúng thứ phải chừa không". Một job nền xoá nhầm thì không ai
 * bấm undo được, và cũng không ai nhìn thấy nó xảy ra.
 *
 * Hai mốc thời gian phải phân biệt, đừng lẫn:
 * - Mã 6 số sống 10 phút (`CODE_TTL_MS`) — hết hạn thì xin mã mới.
 * - Tài khoản có `UNVERIFIED_TTL_DAYS` để xác thực — hết hạn thì mất tài khoản.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let categoryId = ''

const HCM = 'Hồ Chí Minh'

async function models() {
  const { User } = await import('../../src/features/user/user.model')
  const { Favorite } = await import('../../src/features/favorite/favorite.model')
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  return { User, Favorite, RoleGrant }
}

/**
 * Lùi `createdAt` về quá hạn — thay cho việc chờ 7 ngày thật.
 *
 * Đi qua DRIVER GỐC (`User.collection`) chứ không `User.updateOne`: `timestamps: true` khiến
 * Mongoose coi `createdAt` là immutable và LẶNG LẼ bỏ field đó khỏi lượt update — không lỗi,
 * không cảnh báo, chỉ là bản ghi không đổi và test đỏ với một thông điệp chẳng liên quan.
 */
async function backdate(id: string, days: number): Promise<void> {
  const { User } = await models()
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    { $set: { createdAt: past } },
  )
}

/** Đăng ký thô rồi lùi ngày tạo về quá hạn. */
async function staleUnverified(email: string): Promise<mongoose.Types.ObjectId> {
  const u = await registerUser(app, email, 'Bỏ ngang', { verified: false })
  await backdate(u.id, env.UNVERIFIED_TTL_DAYS + 1)
  return new mongoose.Types.ObjectId(u.id)
}

async function exists(id: mongoose.Types.ObjectId): Promise<boolean> {
  const { User } = await models()
  return (await User.countDocuments({ _id: id }).exec()) > 0
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  categoryId = await createCategory('Đồ cũ', 'do-cu')
  master = await makeMaster(app)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Xoá đúng thứ phải xoá', () => {
  it('tài khoản chưa xác thực và quá hạn → BỊ XOÁ, email được trả lại', async () => {
    const id = await staleUnverified('bo-ngang@ghim.local')

    const res = await unverifiedCleanupService.sweep()

    expect(res.deleted).toBeGreaterThanOrEqual(1)
    expect(await exists(id)).toBe(false)

    /*
     * Chốt QUAN TRỌNG NHẤT của cả tính năng, và là lý do phải xoá cứng thay vì `softDelete`:
     * người gõ nhầm email phải đăng ký lại được bằng đúng địa chỉ đó. Xoá mềm giữ `email`
     * (unique) nên lượt đăng ký lại ăn 409 vĩnh viễn.
     */
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Lần hai', email: 'bo-ngang@ghim.local', password: 'password123' })
      .expect(201)
  }, 60_000)

  it('dọn luôn bản ghi phụ, không để lại con trỏ mồ côi', async () => {
    const id = await staleUnverified('co-rac@ghim.local')
    const { Favorite } = await models()
    await Favorite.create({ userId: id, listingId: new mongoose.Types.ObjectId() })

    await unverifiedCleanupService.sweep()

    expect(await exists(id)).toBe(false)
    expect(await Favorite.countDocuments({ userId: id }).exec()).toBe(0)
  }, 60_000)
})

describe('Chừa đúng thứ phải chừa', () => {
  it('CHƯA quá hạn thì không đụng tới — dù chưa xác thực', async () => {
    const u = await registerUser(app, 'vua-dang-ky@ghim.local', 'Vừa đăng ký', {
      verified: false,
    })
    const id = new mongoose.Types.ObjectId(u.id)

    await unverifiedCleanupService.sweep()

    expect(await exists(id)).toBe(true)
  }, 60_000)

  it('ĐÃ xác thực thì không đụng, kể cả tài khoản rất cũ', async () => {
    const u = await registerUser(app, 'da-xac-thuc-cu@ghim.local', 'Đã xác thực')
    await backdate(u.id, 400)

    await unverifiedCleanupService.sweep()

    expect(await exists(new mongoose.Types.ObjectId(u.id))).toBe(true)
  }, 60_000)

  /**
   * Ba ca dưới đây KHÔNG thể xảy ra theo luật hiện tại (`requireVerifiedEmail` chặn đăng tin;
   * membership và grant do người khác cấp). Chốt chúng lại chính vì thế: nếu một ngày luật đổi
   * và chúng xảy ra được, job này không được lặng lẽ xoá dữ liệu của người ta.
   */
  it('có QUYỀN thì bỏ qua, không xoá', async () => {
    const id = await staleUnverified('co-quyen@ghim.local')
    const { RoleGrant } = await models()
    const { SYSTEM_ROLES, SCOPE_TYPES } = await import('../../src/common/constants')
    await RoleGrant.create({
      userId: id,
      role: SYSTEM_ROLES.MASTER,
      scopeType: SCOPE_TYPES.SYSTEM,
    })

    const res = await unverifiedCleanupService.sweep()

    expect(await exists(id)).toBe(true)
    expect(res.skipped).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('là THÀNH VIÊN một nhóm thì bỏ qua', async () => {
    const id = await staleUnverified('la-thanh-vien@ghim.local')
    const { addMember } = await import('../helpers/fixtures')
    const org = await createOrg(app, master.token, {
      name: 'Trường Dọn Dẹp',
      slug: 'truong-don-dep',
      ownerEmail: master.email,
      provinceCode: HCM,
    })
    await addMember(id.toString(), org.id)

    await unverifiedCleanupService.sweep()

    expect(await exists(id)).toBe(true)
  }, 60_000)

  it('có TIN ĐĂNG thì bỏ qua — kể cả tin nằm trong một org', async () => {
    const seller = await registerUser(app, 'co-tin@ghim.local', 'Có tin')
    const org = await createOrg(app, master.token, {
      name: 'Trường Có Tin',
      slug: 'truong-co-tin',
      ownerEmail: seller.email,
      provinceCode: HCM,
    })
    await request(app)
      .post('/api/v1/listings')
      .set(orgAuth(seller.token, org.slug))
      .send({ ...listingPayload('Tin nội bộ', categoryId), visibility: 'org_internal' })
      .expect(201)

    // Hạ cờ xác thực SAU khi đăng tin: dựng đúng trạng thái "chưa xác thực mà vẫn có tài sản".
    const { User } = await models()
    await User.updateOne({ _id: seller.id }, { emailVerifiedAt: null }).exec()
    await backdate(seller.id, env.UNVERIFIED_TTL_DAYS + 1)

    await unverifiedCleanupService.sweep()

    expect(await exists(new mongoose.Types.ObjectId(seller.id))).toBe(true)
  }, 60_000)

  it('chạy trên DB không có gì để dọn → không nổ, trả về 0', async () => {
    const res = await unverifiedCleanupService.sweep()
    expect(res.deleted).toBe(0)
  }, 60_000)
})
