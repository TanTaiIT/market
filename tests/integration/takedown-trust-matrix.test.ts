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
  createOrgUnit,
  createTestApp,
  grantRole,
  listingPayload,
  makeMaster,
  orgAuth,
  publishListing,
  registerUser,
  setTrustLevel,
  startTestDb,
  orgIdOf,
} from '../helpers/fixtures'

/**
 * MA TRẬN của `applyTakedownPenalty` — phần còn lại sau 6 ca cốt lõi ở `takedown-trust.test.ts`.
 * Bám bảng `docs/audits/2.1-takedown-trust.test-cases.md`; mỗi `it` ghi ID của case đó.
 *
 * Ba chiều: đường gỡ (báo cáo `hide_target` / DELETE bàn duyệt) × trục của tin (nội bộ, sàn
 * mang badge nhóm, sàn không nhóm) × trạng thái trước khi gỡ. Cộng vai người gỡ (master, staff
 * nhóm con, chính chủ), gỡ lặp, thông báo, và đuôi uy tín trong nhật ký.
 *
 * Mỗi ca dựng người bán MỚI: bậc uy tín không tự hồi, dùng chung là ca sau đo nhầm ca trước.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let ownerA: TestUser
let ownerB: TestUser
/** Phụ trách ô (Đồ dùng × HCM). */
let catManager: TestUser
/** Staff nhóm con U1 của nhóm A. */
let staffU1: TestUser
/** Thành viên nhóm A không có quyền gì — người tố tin nội bộ. */
let reporter: TestUser
let buyer: TestUser
let buyer2: TestUser
let categoryId = ''
let unitU1 = ''
let unitU2 = ''
const ORG_A = 'nhom-matrix-a'
const ORG_B = 'nhom-matrix-b'
const HCM = 'Hồ Chí Minh'
const QUOTE = 'Yêu cầu chuyển khoản trước khi cho xem hàng'
let seq = 0

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

const trustOf = async (userId: string) => {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  return UserTrust.findOne({ userId }).lean().exec()
}
const levelOf = async (userId: string) => {
  const { INITIAL_TRUST } = await import('../../src/features/trust/trust.policy')
  return (await trustOf(userId))?.level ?? INITIAL_TRUST.level
}

/** Người bán mới toanh, thuộc nhóm A (tuỳ chọn nhóm con). */
async function newSeller(opts: { unitId?: string; org?: string } = {}) {
  seq += 1
  const u = await registerUser(app, `seller-${seq}@matrix.local`, `Người bán ${seq}`)
  await addMember(u.id, orgIdOf(opts.org ?? ORG_A), { unitId: opts.unitId ?? null })
  return u
}

async function newLone() {
  seq += 1
  return registerUser(app, `lone-${seq}@matrix.local`, `Người bán lẻ ${seq}`)
}

type Created = { _id: string; status: string; organizationId: string | null; title: string }

async function post(who: TestUser, body: Record<string, unknown>, headers: Record<string, string>) {
  seq += 1
  const title = `Tin số ${seq}`
  const res = await request(app)
    .post('/api/v1/listings')
    .set(headers)
    .send({ ...listingPayload(title, categoryId), ...body })
    .expect(201)
  return { ...(res.body.data as Omit<Created, 'title'>), title }
}

/** Tin NỘI BỘ của nhóm A (hoặc `org`), tự lên bảng với người bậc 2. */
const postInternal = (who: TestUser, org = ORG_A) =>
  post(who, { reach: 'members' }, orgAuth(who.token, org))
/** Tin SÀN mang badge nhóm A. */
const postBadge = (who: TestUser) =>
  post(who, { reach: 'marketplace', provinceCode: HCM }, orgAuth(who.token, ORG_A))
/** Tin SÀN không nhóm. */
const postLone = (who: TestUser) =>
  post(who, { reach: 'marketplace', provinceCode: HCM }, bearer(who))

async function report(who: TestUser, listingId: string, headers = bearer(who)) {
  const res = await request(app)
    .post('/api/v1/reports')
    .set(headers)
    .send({ targetType: 'listing', targetId: listingId, kind: 'scam', quote: QUOTE })
    .expect(201)
  return res.body.data.id as string
}

const resolve = (who: TestUser, reportId: string, action: string, headers = bearer(who)) =>
  request(app).patch(`/api/v1/reports/${reportId}`).set(headers).send({ action })

const remove = (who: TestUser, listingId: string, headers = bearer(who), body?: object) => {
  const req = request(app).delete(`/api/v1/moderation/listings/${listingId}`).set(headers)
  return body === undefined ? req : req.send(body)
}

async function setDoc(id: string, patch: Record<string, unknown>) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test sửa tin', () => Listing.updateOne({ _id: id }, patch).exec())
}

/** Dòng nhật ký của nhóm A nhắc tới tiêu đề này. */
async function activityAbout(title: string): Promise<string | undefined> {
  const res = await request(app)
    .get('/api/v1/moderation/activity')
    .set(orgAuth(ownerA.token, ORG_A))
    .expect(200)
  const row = (res.body.data as { summary: string }[]).find((r) => r.summary.includes(title))
  return row?.summary
}

async function inboxOf(who: TestUser) {
  const res = await request(app).get('/api/v1/notifications').set(bearer(who)).expect(200)
  return res.body.data as { title: string; body: string }[]
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-matrix')
  master = await makeMaster(app)
  ownerA = await registerUser(app, 'owner-a@matrix.local', 'Chủ nhóm A')
  ownerB = await registerUser(app, 'owner-b@matrix.local', 'Chủ nhóm B')
  catManager = await registerUser(app, 'catman@matrix.local', 'Phụ trách Đồ dùng HCM')
  staffU1 = await registerUser(app, 'staff-u1@matrix.local', 'Staff U1')
  reporter = await registerUser(app, 'reporter@matrix.local', 'Người tố')
  buyer = await registerUser(app, 'buyer@matrix.local', 'Người mua')
  buyer2 = await registerUser(app, 'buyer2@matrix.local', 'Người mua 2')

  await createOrg(app, master.token, {
    name: 'Nhóm Matrix A',
    key: ORG_A,
    ownerEmail: ownerA.email,
    orgType: 'school',
    provinceCode: HCM,
  })
  await createOrg(app, master.token, {
    name: 'Nhóm Matrix B',
    key: ORG_B,
    ownerEmail: ownerB.email,
    provinceCode: HCM,
  })
  unitU1 = await createOrgUnit(orgIdOf(ORG_A), 'U1')
  unitU2 = await createOrgUnit(orgIdOf(ORG_A), 'U2')

  await addMember(reporter.id, orgIdOf(ORG_A))
  await grantRole({
    userId: catManager.id,
    role: 'manager',
    scopeType: 'category_province',
    categoryId,
    provinceCodes: [HCM],
  })
  await grantRole({
    userId: staffU1.id,
    role: 'staff',
    scopeType: 'org_unit',
    orgId: orgIdOf(ORG_A),
    unitId: unitU1,
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

// ── A. Đường báo cáo — vai người gỡ ────────────────────────────────────────────

describe('A. Đường báo cáo', () => {
  it('A4 master gỡ tin sàn mang badge nhóm qua báo cáo → phạt (master duyệt được mọi trục)', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    const r = await report(buyer, l._id)
    await resolve(master, r, 'hide_target', orgAuth(master.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('A5 master gỡ tin sàn không nhóm qua báo cáo → phạt', async () => {
    const seller = await newLone()
    const l = await postLone(seller)
    const r = await report(buyer, l._id)
    await resolve(master, r, 'hide_target').expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('A6 staff nhóm con gỡ tin nội bộ ĐÚNG nhóm con qua báo cáo → phạt', async () => {
    const seller = await newSeller({ unitId: unitU1 })
    const l = await postInternal(seller)
    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    await resolve(staffU1, r, 'hide_target', orgAuth(staffU1.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('A7 `ignore` → đóng báo cáo, tin còn nguyên, không phạt', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    const res = await resolve(ownerA, r, 'ignore', orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(res.body.data.status).toBe('dismissed')

    await request(app)
      .get(`/api/v1/listings/${l._id}`)
      .set(orgAuth(reporter.token, ORG_A))
      .expect(200)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('A8 báo cáo về NGƯỜI + `hide_target` → chỉ đóng, không ẩn gì, không phạt', async () => {
    const target = await newSeller()
    const res = await request(app)
      .post('/api/v1/reports')
      .set(orgAuth(reporter.token, ORG_A))
      .send({ targetType: 'user', targetId: target.id, kind: 'harassment', quote: QUOTE })
      .expect(201)
    const closed = await resolve(
      ownerA,
      res.body.data.id,
      'hide_target',
      orgAuth(ownerA.token, ORG_A),
    ).expect(200)
    expect(closed.body.data.status).toBe('dismissed')
    expect(await levelOf(target.id)).toBe(2)
  }, 60_000)
})

// ── B. Đường bàn duyệt — vai người gỡ ──────────────────────────────────────────

describe('B. Đường bàn duyệt', () => {
  it('B3 quản trị nhóm KHÔNG gỡ được tin sàn không nhóm — 403, không phạt', async () => {
    const seller = await newLone()
    const l = await postLone(seller)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(403)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('B4 phụ trách ô gỡ tin sàn không nhóm ở bàn duyệt → phạt', async () => {
    const seller = await newLone()
    const l = await postLone(seller)
    await remove(catManager, l._id).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('B5 phụ trách ô gỡ tin sàn mang badge nhóm → phạt (badge không đổi trục của tin)', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    await remove(catManager, l._id).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('B6 master gỡ tin sàn mang badge nhóm ở bàn duyệt → phạt', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    await remove(master, l._id, orgAuth(master.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('B7 staff nhóm con gỡ tin nội bộ ĐÚNG nhóm con → phạt', async () => {
    const seller = await newSeller({ unitId: unitU1 })
    const l = await postInternal(seller)
    await remove(staffU1, l._id, orgAuth(staffU1.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('B8 staff nhóm con KHÔNG gỡ được tin của nhóm con khác — 403', async () => {
    const seller = await newSeller({ unitId: unitU2 })
    const l = await postInternal(seller)
    await remove(staffU1, l._id, orgAuth(staffU1.token, ORG_A)).expect(403)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)
})

// ── C. Trạng thái trước khi gỡ ─────────────────────────────────────────────────

describe('C. Trạng thái tin trước khi gỡ quyết định P1', () => {
  it('C2 tin `pending_unverified` của người ngoài → gỡ không phạt', async () => {
    const outsider = await newLone()
    const res = await request(app)
      .post('/api/v1/listings')
      .set(bearer(outsider))
      .send({
        ...listingPayload('Tin người ngoài gửi vào nhóm', categoryId),
        orgId: orgIdOf(ORG_A),
      })
      .expect(201)
    expect(res.body.data.status).toBe('pending_unverified')

    await remove(ownerA, res.body.data._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(outsider.id)).toBe(2)
  }, 60_000)

  it('C3 tin `sold` → gỡ vẫn phạt (đã tới tay người mua)', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await request(app).post(`/api/v1/listings/${l._id}/sold`).set(bearer(seller)).expect(200)

    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('C4 tin `expired` → gỡ vẫn phạt', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await setDoc(l._id, { status: 'expired' })

    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('C5 tin đã ẨN thường (không phạt) rồi gỡ → không phạt, ẩn không phải "lên bảng"', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await request(app)
      .patch(`/api/v1/moderation/listings/${l._id}`)
      .set(orgAuth(ownerA.token, ORG_A))
      .send({ status: 'hidden', reason: 'Chờ xác minh' })
      .expect(200)
    expect(await levelOf(seller.id)).toBe(2)

    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('C6 tin `rejected` → gỡ không phạt thêm', async () => {
    const seller = await newSeller()
    await setTrustLevel(seller.id, 1)
    const l = await postInternal(seller)
    expect(l.status).toBe('pending')
    await request(app)
      .patch(`/api/v1/moderation/listings/${l._id}`)
      .set(orgAuth(ownerA.token, ORG_A))
      .send({ status: 'rejected', reason: 'Ảnh mờ' })
      .expect(200)
    // Từ chối mức `quality` (mặc định) không đụng uy tín — audit 2.9.
    expect(await levelOf(seller.id)).toBe(1)

    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('C7 báo cáo tin `sold` rồi `hide_target` → phạt', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await request(app).post(`/api/v1/listings/${l._id}/sold`).set(bearer(seller)).expect(200)

    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('C8 không báo cáo được tin chưa lên bảng — 404 ngay lúc tạo', async () => {
    const seller = await newSeller()
    await setTrustLevel(seller.id, 1)
    const l = await postInternal(seller)
    expect(l.status).toBe('pending')

    await request(app)
      .post('/api/v1/reports')
      .set(orgAuth(reporter.token, ORG_A))
      .send({ targetType: 'listing', targetId: l._id, kind: 'scam', quote: QUOTE })
      .expect(404)
  }, 60_000)
})

// ── D. Tự xử, gỡ lặp, sàn dưới ─────────────────────────────────────────────────

describe('D. Tự xử, gỡ lặp, sàn dưới', () => {
  it('D1 chủ nhóm tự gỡ tin của mình → không phạt, nhật ký không đuôi uy tín', async () => {
    const l = await postInternal(ownerA)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A), { reason: 'Đăng nhầm' }).expect(200)

    expect(await levelOf(ownerA.id)).toBe(2)
    const line = await activityAbout(l.title)
    expect(line).toContain('Đăng nhầm')
    expect(line).not.toContain('uy tín bậc')
  }, 60_000)

  it('D3 phụ trách ô tự gỡ tin sàn của mình → không phạt', async () => {
    const l = await postLone(catManager)
    await remove(catManager, l._id).expect(200)
    expect(await levelOf(catManager.id)).toBe(2)
  }, 60_000)

  it('D4 đóng cùng một báo cáo hai lần → 400, bậc chỉ tụt một', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(200)
    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(400)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('D5 hai người cùng báo cáo một tin → xử một là đóng cả hai, bậc tụt đúng một', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    const r1 = await report(buyer, l._id)
    const r2 = await report(buyer2, l._id)

    // Tin sàn mang badge: master xử để có án (nhóm gỡ thì không ghi án — A1).
    await resolve(master, r1, 'hide_target', orgAuth(master.token, ORG_A)).expect(200)
    await resolve(master, r2, 'hide_target', orgAuth(master.token, ORG_A)).expect(400)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('D6 DELETE hai lần → lần hai 404, bậc không tụt thêm', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(404)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('D7 đã gỡ qua báo cáo rồi DELETE tiếp → không phạt lần hai (tin đang `hidden`)', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)

    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('D8 đã ở bậc 0 thì gỡ thêm cũng không âm', async () => {
    const seller = await newSeller()
    const first = await postInternal(seller)
    await remove(ownerA, first._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(1)

    // Bậc 1 không tự đăng — ép ACTIVE ở tầng model để có tin "đã lên bảng" mà gỡ.
    const second = await postInternal(seller)
    await publishListing(second._id)
    await remove(ownerA, second._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(0)

    const third = await postInternal(seller)
    await publishListing(third._id)
    await remove(ownerA, third._id, orgAuth(ownerA.token, ORG_A)).expect(200)
    expect(await levelOf(seller.id)).toBe(0)
  }, 60_000)
})

// ── E. Thông báo, body DELETE, nhật ký ─────────────────────────────────────────

describe('E. Thông báo và nhật ký', () => {
  it('E2 DELETE body `{}` → 200', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A), {}).expect(200)
  }, 60_000)

  it('E3 `reason` rỗng / quá dài / field lạ → 400, không gỡ, không phạt', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const h = orgAuth(ownerA.token, ORG_A)
    await remove(ownerA, l._id, h, { reason: '' }).expect(400)
    await remove(ownerA, l._id, h, { reason: 'x'.repeat(301) }).expect(400)
    await remove(ownerA, l._id, h, { note: 'x' }).expect(400)

    await request(app)
      .get(`/api/v1/listings/${l._id}`)
      .set(orgAuth(reporter.token, ORG_A))
      .expect(200)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('E5 gỡ không lý do → thông báo dòng chung', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await remove(ownerA, l._id, orgAuth(ownerA.token, ORG_A)).expect(200)

    const note = (await inboxOf(seller)).find((n) => n.title === 'Tin của bạn đã bị gỡ')
    expect(note?.body).toBe(`"${l.title}" không còn trên bảng tin.`)
  }, 60_000)

  it('E6 gỡ qua báo cáo → thông báo "đã bị ẩn" kèm loại báo cáo', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    const r = await report(reporter, l._id, orgAuth(reporter.token, ORG_A))
    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(200)

    const note = (await inboxOf(seller)).find((n) => n.title === 'Tin của bạn đã bị ẩn')
    expect(note?.body).toContain('Bị báo cáo: scam')
  }, 60_000)

  it('E7 nhật ký bàn duyệt: đuôi uy tín chỉ khi phạt', async () => {
    const seller = await newSeller()
    const internal = await postInternal(seller)
    const badge = await postBadge(seller)
    const h = orgAuth(ownerA.token, ORG_A)
    await remove(ownerA, badge._id, h).expect(200) // không phạt
    await remove(ownerA, internal._id, h, { reason: 'Bán hàng giả' }).expect(200) // phạt

    expect(await activityAbout(badge.title)).toBe(`Gỡ "${badge.title}" khỏi bảng`)
    expect(await activityAbout(internal.title)).toBe(
      `Gỡ "${internal.title}" khỏi bảng · Bán hàng giả · uy tín bậc 1`,
    )
  }, 60_000)

  it('E8 nhật ký báo cáo: đuôi uy tín chỉ khi phạt (không còn "bậc 0")', async () => {
    const seller = await newSeller()
    const internal = await postInternal(seller)
    const badge = await postBadge(seller)
    const rBadge = await report(buyer, badge._id)
    const rInternal = await report(reporter, internal._id, orgAuth(reporter.token, ORG_A))
    const h = orgAuth(ownerA.token, ORG_A)
    await resolve(ownerA, rBadge, 'hide_target', h).expect(200) // không phạt
    await resolve(ownerA, rInternal, 'hide_target', h).expect(200) // phạt

    // Báo cáo tin sàn nằm trên trục công khai (2.8), mà trục đó chưa có audit (nợ AuditLog
    // dual-axis): nhật ký nhóm KHÔNG có dòng nào — chứ không phải một dòng "bậc 0" như trước.
    expect(await activityAbout(badge.title)).toBeUndefined()
    expect(await activityAbout(internal.title)).toBe(
      `Gỡ "${internal.title}" sau báo cáo · uy tín bậc 1`,
    )
  }, 60_000)
})

// ── G. Từ chối quyền ───────────────────────────────────────────────────────────

describe('G. Từ chối quyền — không tới được bước phạt', () => {
  it('G5 quản trị nhóm KHÁC gỡ tin nội bộ → 404, không lộ sự tồn tại', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await remove(ownerB, l._id, orgAuth(ownerB.token, ORG_B)).expect(404)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('G6 phụ trách ô gỡ tin nội bộ → 404', async () => {
    const seller = await newSeller()
    const l = await postInternal(seller)
    await remove(catManager, l._id).expect(404)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)

  it('G8a báo cáo tin sàn mang badge nhóm nằm trên TRỤC CÔNG KHAI — người phụ trách ô thấy và phạt được', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    const r = await report(buyer, l._id)

    // Đóng dấu theo `reach`, không theo badge: `organizationId` null + toạ độ ô của tin.
    const { Report } = await import('../../src/features/report/report.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const row = await runUnscoped('test: đọc báo cáo', () => Report.findById(r).lean().exec())
    expect(row?.organizationId).toBeNull()
    expect(row?.category?.toString()).toBe(categoryId)
    expect(row?.provinceCode).toBe(HCM)

    const ids = async (headers: Record<string, string>) => {
      const res = await request(app).get('/api/v1/reports?status=open').set(headers).expect(200)
      return (res.body.data as { id: string }[]).map((x) => x.id)
    }
    expect(await ids(bearer(catManager))).toContain(r)
    // Hàng đợi của nhóm không còn nó: đây là hàng đợi của trục sàn.
    expect(await ids(orgAuth(ownerA.token, ORG_A))).not.toContain(r)

    await resolve(catManager, r, 'hide_target').expect(200)
    expect(await levelOf(seller.id)).toBe(1)
  }, 60_000)

  it('G8b nhóm cầm id vẫn gỡ được tin mang tên mình qua báo cáo trục sàn — nhưng không ghi án', async () => {
    const seller = await newSeller()
    const l = await postBadge(seller)
    const r = await report(buyer, l._id)

    await resolve(ownerA, r, 'hide_target', orgAuth(ownerA.token, ORG_A)).expect(200)
    await request(app).get(`/api/v1/listings/${l._id}`).expect(404)
    expect(await levelOf(seller.id)).toBe(2)
  }, 60_000)
})
