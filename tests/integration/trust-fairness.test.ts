import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createCategory,
  createOrg,
  createTestApp,
  listingPayload,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
/** Chủ nhóm A — vừa là người đăng vừa là người duyệt, đúng hình mẫu lỗ farm. */
let ownerA: TestUser
let memberA: TestUser
/** Chủ nhóm B — dùng để xử tin của người ngoài. */
let ownerB: TestUser
let stranger: TestUser
let categoryId = ''
const SLUG_A = 'nhom-uy-tin-a'
const SLUG_B = 'nhom-uy-tin-b'

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung')
  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner-a@fair.local', 'Chủ nhóm A')
  memberA = await registerUser(app, 'member-a@fair.local', 'Thành viên A')
  ownerB = await registerUser(app, 'owner-b@fair.local', 'Chủ nhóm B')
  stranger = await registerUser(app, 'stranger@fair.local', 'Người ngoài')

  const orgA = await createOrg(app, master.token, {
    name: 'Nhóm A',
    slug: SLUG_A,
    ownerEmail: ownerA.email,
  })
  await createOrg(app, master.token, {
    name: 'Nhóm B',
    slug: SLUG_B,
    ownerEmail: ownerB.email,
  })
  await addMember(memberA.id, orgA.id)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const trustOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  return UserTrust.findOne({ userId }).lean().exec()
}

const postInOrg = (who: TestUser, slug: string, title: string, body = {}) =>
  request(app)
    .post('/api/v1/listings')
    .set(orgAuth(who.token, slug))
    .send({ ...listingPayload(title, categoryId), ...body })

const decide = (who: TestUser, slug: string, id: string, status: string, reason?: string) =>
  request(app)
    .patch(`/api/v1/moderation/listings/${id}`)
    .set(orgAuth(who.token, slug))
    .send({ status, ...(reason ? { reason } : {}) })

describe('Uy tín — không farm được bằng cách tự duyệt tin của mình', () => {
  it('chủ nhóm tự bấm duyệt tin của CHÍNH MÌNH: duyệt được, nhưng KHÔNG cộng bậc', async () => {
    const created = await postInOrg(ownerA, SLUG_A, 'Tin của chính chủ nhóm').expect(201)

    // Thao tác vẫn hợp lệ — họ có quyền duyệt thật trong nhóm mình.
    await decide(ownerA, SLUG_A, created.body.data._id, 'active').expect(200)

    // Nhưng không ai độc lập nhìn tin đó, nên nó không phải bằng chứng về uy tín.
    expect(await trustOf(ownerA.id)).toBeNull()
  }, 60_000)

  it('người KHÁC duyệt thì vẫn cộng bình thường — chốt trên không làm hỏng đường thật', async () => {
    const created = await postInOrg(memberA, SLUG_A, 'Tin của thành viên').expect(201)

    await decide(ownerA, SLUG_A, created.body.data._id, 'active').expect(200)

    expect(await trustOf(memberA.id)).toMatchObject({ cleanApprovals: 1 })
  }, 60_000)

  it('tự từ chối tin của mình cũng không trừ bậc — chốt chặn cả hai chiều', async () => {
    const created = await postInOrg(ownerA, SLUG_A, 'Tin tự từ chối').expect(201)

    await decide(ownerA, SLUG_A, created.body.data._id, 'rejected', 'Tự thấy không ổn').expect(200)

    expect(await trustOf(ownerA.id)).toBeNull()
  }, 60_000)
})

describe('Uy tín — nhóm lạ không hạ được vị thế toàn sàn', () => {
  it('người ngoài bị nhóm lạ TỪ CHỐI: mất tin đó, KHÔNG mất bậc', async () => {
    const created = await request(app)
      .post('/api/v1/listings')
      .set(bearer(stranger))
      .send({ ...listingPayload('Tin gửi vào nhóm lạ', categoryId), orgSlug: SLUG_B })
      .expect(201)
    expect(created.body.data.status).toBe('pending_unverified')

    await decide(ownerB, SLUG_B, created.body.data._id, 'rejected', 'Không phù hợp nhóm').expect(
      200,
    )

    // "Không phù hợp nhóm tôi" khác "vi phạm quy định sàn" — chỉ cái sau mới đụng uy tín.
    expect(await trustOf(stranger.id)).toBeNull()
  }, 60_000)

  it('nhóm lạ DUYỆT tin người ngoài cũng không cộng bậc — bịt farm bằng người quen', async () => {
    const created = await request(app)
      .post('/api/v1/listings')
      .set(bearer(stranger))
      .send({ ...listingPayload('Tin thứ hai gửi vào nhóm lạ', categoryId), orgSlug: SLUG_B })
      .expect(201)

    await decide(ownerB, SLUG_B, created.body.data._id, 'active').expect(200)

    expect(await trustOf(stranger.id)).toBeNull()
  }, 60_000)
})

describe('Uy tín — người bán thấy được vị thế của mình', () => {
  it('người mới: chưa tự đăng được, biết còn bao nhiêu tin nữa, không bị phạt', async () => {
    const rookie = await registerUser(app, 'rookie@fair.local', 'Người mới')

    const res = await request(app).get('/api/v1/listings/quota').set(bearer(rookie)).expect(200)

    expect(res.body.data.standing).toEqual({
      canSelfPublish: false,
      cleanApprovalsNeeded: 10,
      penalty: null,
    })
    // Cố tình KHÔNG lộ con số bậc — bậc chặn trần nên nó không nói thêm được gì.
    expect(res.body.data.standing).not.toHaveProperty('trustLevel')
  }, 60_000)

  it('đang bị phạt: nói rõ mấy lượt từ chối và hết phạt lúc nào', async () => {
    const punished = await registerUser(app, 'punished@fair.local', 'Người bị phạt')
    await addMember(punished.id, (await orgIdOf(SLUG_A)).toString())

    const created = await postInOrg(punished, SLUG_A, 'Tin sẽ bị từ chối').expect(201)
    // Phải là VI PHẠM mới sinh án — từ chối vì sai sót không còn phạt ai nữa.
    await request(app)
      .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
      .set(orgAuth(ownerA.token, SLUG_A))
      .send({ status: 'rejected', reason: 'Hàng cấm', severity: 'violation' })
      .expect(200)

    const res = await request(app).get('/api/v1/listings/quota').set(bearer(punished)).expect(200)

    expect(res.body.data.standing.canSelfPublish).toBe(false)
    expect(res.body.data.standing.penalty.rejections).toBe(1)
    // Hết phạt đúng 7 ngày sau lượt từ chối — người bán đọc được, không phải đoán.
    const until = new Date(res.body.data.standing.penalty.until).getTime()
    const days = (until - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.5)
    expect(days).toBeLessThan(7.1)
  }, 60_000)
})

async function orgIdOf(slug: string) {
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findOne({ slug }).lean().exec()
  return org!._id
}

describe('Uy tín — mức độ từ chối quyết định cái giá', () => {
  /** Người mới, sạch tiểu sử, thuộc nhóm A để ownerA duyệt được. */
  async function freshMember(email: string) {
    const u = await registerUser(app, email, 'Người bán')
    await addMember(u.id, (await orgIdOf(SLUG_A)).toString())
    return u
  }

  it('từ chối vì SAI SÓT (mặc định): không trừ bậc, không bóp hạn mức', async () => {
    const seller = await freshMember('quality@fair.local')
    const created = await postInOrg(seller, SLUG_A, 'Tin ảnh mờ').expect(201)

    // Không gửi `severity` → mặc định `quality`. Người duyệt phải CHỦ ĐỘNG mới trừng phạt.
    await decide(ownerA, SLUG_A, created.body.data._id, 'rejected', 'Ảnh chưa rõ sản phẩm').expect(
      200,
    )

    expect(await trustOf(seller.id)).toBeNull()
    const q = await request(app).get('/api/v1/listings/quota').set(bearer(seller)).expect(200)
    expect(q.body.data.standing.penalty).toBeNull()
    expect(q.body.data.limit).toBe(3) // hạn mức bậc 0 nguyên vẹn
  }, 60_000)

  it('từ chối vì VI PHẠM: trừ bậc và vào cửa sổ phạt', async () => {
    const seller = await freshMember('violation@fair.local')
    // Cho họ một bài sạch trước để có bậc mà trừ.
    const clean = await postInOrg(seller, SLUG_A, 'Tin sạch đầu tiên').expect(201)
    await decide(ownerA, SLUG_A, clean.body.data._id, 'active').expect(200)
    expect(await trustOf(seller.id)).toMatchObject({ cleanApprovals: 1 })

    const bad = await postInOrg(seller, SLUG_A, 'Tin vi phạm quy định').expect(201)
    await request(app)
      .patch(`/api/v1/moderation/listings/${bad.body.data._id}`)
      .set(orgAuth(ownerA.token, SLUG_A))
      .send({ status: 'rejected', reason: 'Hàng không được phép bán', severity: 'violation' })
      .expect(200)

    // Chuỗi sạch bị xoá, và án phạt bật lên.
    expect(await trustOf(seller.id)).toMatchObject({ cleanApprovals: 0 })
    const q = await request(app).get('/api/v1/listings/quota').set(bearer(seller)).expect(200)
    expect(q.body.data.standing.penalty.rejections).toBe(1)
    expect(q.body.data.limit).toBe(2) // hạn mức hồi phục, đủ 2 slot chứ không phải 1
  }, 60_000)
})

describe('Án phạt — master gỡ được, và chỉ gỡ đúng phần nên gỡ', () => {
  it('ba vi phạm khoá quyền đăng; master gỡ thì đăng lại được nhưng bậc KHÔNG được tha', async () => {
    const seller = await registerUser(app, 'blocked@fair.local', 'Người bị khoá')
    await addMember(seller.id, (await orgIdOf(SLUG_A)).toString())

    for (let i = 0; i < 3; i += 1) {
      const created = await postInOrg(seller, SLUG_A, `Tin vi phạm số ${i + 1}`).expect(201)
      await request(app)
        .patch(`/api/v1/moderation/listings/${created.body.data._id}`)
        .set(orgAuth(ownerA.token, SLUG_A))
        .send({ status: 'rejected', reason: 'Vi phạm quy định', severity: 'violation' })
        .expect(200)
    }

    // Khoá cứng: 3 vi phạm trong cửa sổ.
    const blocked = await request(app).get('/api/v1/listings/quota').set(bearer(seller)).expect(200)
    expect(blocked.body.data.allowed).toBe(false)
    expect(blocked.body.data.reason).toBe('blocked_by_rejections')
    // 403 chứ không 409: hết slot là 409, còn đây là QUYỀN đăng bị khoá — xem `quotaError`.
    await postInOrg(seller, SLUG_A, 'Tin bị chặn').expect(403)

    const lift = await request(app)
      .post(`/api/v1/users/${seller.id}/clear-rejections`)
      .set({ Authorization: `Bearer ${master.token}` })
      .send({ reason: 'Đã xác minh: người duyệt bấm nhầm cả ba lượt' })
      .expect(200)
    expect(lift.body.data.cleared).toBe(3)

    // Đăng lại được, và người bán được báo.
    await postInOrg(seller, SLUG_A, 'Tin sau khi gỡ án').expect(201)
    const inbox = await request(app).get('/api/v1/notifications').set(bearer(seller)).expect(200)
    expect(
      inbox.body.data.some((n: { title: string }) => n.title === 'Án phạt đăng tin đã được gỡ'),
    ).toBe(true)
  }, 60_000)

  it('không có án nào thì gỡ ra 409 — không phải nút bấm cho vui', async () => {
    const clean = await registerUser(app, 'noban@fair.local', 'Người sạch')
    await request(app)
      .post(`/api/v1/users/${clean.id}/clear-rejections`)
      .set({ Authorization: `Bearer ${master.token}` })
      .send({ reason: 'Thử gỡ án không tồn tại' })
      .expect(409)
  }, 60_000)

  it('người thường không tự gỡ án cho mình', async () => {
    await request(app)
      .post(`/api/v1/users/${stranger.id}/clear-rejections`)
      .set(bearer(stranger))
      .send({ reason: 'Tự tha cho mình' })
      .expect(403)
  })
})

describe('Vị thế — "còn mấy tin nữa" phải đếm cả phần đã đi được', () => {
  it('mỗi tin được duyệt trừ đi đúng một, không đứng yên rồi nhảy 5', async () => {
    const seller = await registerUser(app, 'progress@fair.local', 'Người đang leo')
    await addMember(seller.id, (await orgIdOf(SLUG_A)).toString())

    const needed = async () => {
      const res = await request(app).get('/api/v1/listings/quota').set(bearer(seller)).expect(200)
      return res.body.data.standing.cleanApprovalsNeeded as number
    }

    expect(await needed()).toBe(10)

    // Ba tin sạch: con số phải xuống 7, KHÔNG phải đứng ở 10 tới lúc lên bậc.
    for (let i = 0; i < 3; i += 1) {
      const created = await postInOrg(seller, SLUG_A, `Tin sạch số ${i + 1}`).expect(201)
      await decide(ownerA, SLUG_A, created.body.data._id, 'active').expect(200)
      expect(await needed()).toBe(10 - (i + 1))
    }

    // Đủ 5 tin = lên bậc 1, và con số vắt qua mốc bậc vẫn liền mạch: 5 rồi 4.
    for (let i = 3; i < 6; i += 1) {
      const created = await postInOrg(seller, SLUG_A, `Tin sạch số ${i + 1}`).expect(201)
      await decide(ownerA, SLUG_A, created.body.data._id, 'active').expect(200)
    }
    expect(await needed()).toBe(4)
  }, 60_000)

  it('tới trần thì về 0 và không âm', async () => {
    const seller = await registerUser(app, 'capped@fair.local', 'Người đã tới trần')
    await addMember(seller.id, (await orgIdOf(SLUG_A)).toString())

    for (let i = 0; i < 10; i += 1) {
      const created = await postInOrg(seller, SLUG_A, `Tin sạch ${i + 1}`).expect(201)
      await decide(ownerA, SLUG_A, created.body.data._id, 'active').expect(200)
    }

    const res = await request(app).get('/api/v1/listings/quota').set(bearer(seller)).expect(200)
    expect(res.body.data.standing).toEqual({
      canSelfPublish: true,
      cleanApprovalsNeeded: 0,
      penalty: null,
    })
  }, 90_000)
})
