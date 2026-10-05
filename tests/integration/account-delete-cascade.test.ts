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
  orgIdOf,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import { CASCADE_HIDE_KIND } from '../../src/common/constants'

/**
 * Xoá tài khoản phải kéo theo mọi thứ bám vào nó (audit 3.4): tin đang sống (mang snapshot SĐT),
 * hộp thư chat phía người đó, đơn xin vào nhóm và lời mời đang treo, hồ sơ KYC. Trước đây chỉ
 * `deletedAt` đổi.
 */
let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
let leaver: TestUser
let buyer: TestUser
let categoryId = ''
let orgId = ''
let privateOrgId = ''
const ORG = 'nhom-xoa-tk'
const PRIVATE_ORG = 'nhom-kin-xoa-tk'

let listingId = ''
let conversationId = ''

const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })

async function unscoped<T>(reason: string, fn: () => Promise<T>) {
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  return runUnscoped(reason, fn)
}

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  categoryId = await createCategory('Đồ dùng', 'do-dung-delete')
  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@delete.local', 'Chủ nhóm')
  orgId = (
    await createOrg(app, master.token, { name: 'Nhóm xoá TK', key: ORG, ownerEmail: owner.email })
  ).id
  privateOrgId = (
    await createOrg(app, master.token, {
      name: 'Nhóm kín',
      key: PRIVATE_ORG,
      ownerEmail: owner.email,
    })
  ).id
  await request(app)
    .patch(`/api/v1/organizations/${privateOrgId}/visibility`)
    .set(bearer(master))
    .send({ isPublic: false })
    .expect(200)

  leaver = await registerUser(app, 'leaver@delete.local', 'Người xoá tài khoản')
  await addMember(leaver.id, orgIdOf(ORG))
  buyer = await registerUser(app, 'buyer@delete.local', 'Người mua')

  // Tin đang hiện (bậc trần → active ngay), có cả tin sàn để người mua mở chat.
  const posted = await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(leaver.token, ORG))
    .send({ ...listingPayload('Tủ lạnh mini', categoryId), reach: 'marketplace' })
    .expect(201)
  listingId = posted.body.data._id
  const { Listing } = await import('../../src/features/listing/listing.model')
  await unscoped('test: đưa tin lên bảng', () =>
    Listing.updateOne({ _id: listingId }, { status: 'active' }).exec(),
  )

  const chat = await request(app)
    .post('/api/v1/chats')
    .set(bearer(buyer))
    .send({ listingId })
    .expect(201)
  conversationId = chat.body.data.id ?? chat.body.data._id

  // Đơn xin vào nhóm KÍN bằng mã → đơn chờ (nhóm công khai thì vào ngay, không có gì để huỷ).
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findById(privateOrgId).lean().exec()
  await request(app)
    .post('/api/v1/join-requests')
    .set(bearer(leaver))
    .send({ code: org!.joinCode, claimedName: 'Người xoá tài khoản' })
    .expect(201)

  // Lời mời đích danh và hồ sơ KYC dựng thẳng ở tầng model — chỉ cần bản ghi tồn tại.
  const { Invite } = await import('../../src/features/invite/invite.model')
  await Invite.create({
    organizationId: new mongoose.Types.ObjectId(orgId),
    channel: 'email',
    value: 'leaver@delete.local',
    kind: 'direct',
    tokenHash: 'hash-test-delete',
    invitedUserId: new mongoose.Types.ObjectId(leaver.id),
    status: 'pending',
    invitedBy: new mongoose.Types.ObjectId(owner.id),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  const { KycProfile } = await import('../../src/features/kyc/kyc.model')
  await KycProfile.create({
    userId: new mongoose.Types.ObjectId(leaver.id),
    subjectType: 'individual',
    fullName: 'Người xoá tài khoản',
    birthDate: new Date('1990-01-01'),
    idNumber: '001090000000',
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('DELETE /users/me', () => {
  it('xoá xong: tin ẩn với dấu cascade, chat ẩn phía họ, đơn huỷ, lời mời thu hồi, KYC xoá', async () => {
    await request(app).delete('/api/v1/users/me').set(bearer(leaver)).expect(200)

    const { Listing } = await import('../../src/features/listing/listing.model')
    const listing = await unscoped('test: đọc tin', () =>
      Listing.findById(listingId).select('status moderation').lean().exec(),
    )
    expect(listing?.status).toBe('hidden')
    expect(listing?.moderation).toMatchObject({
      cascade: CASCADE_HIDE_KIND.ACCOUNT_DELETED,
      byName: 'Người xoá tài khoản',
    })

    const { Conversation } = await import('../../src/features/chat/chat.model')
    const convo = await unscoped('test: đọc hội thoại', () =>
      Conversation.findById(conversationId).lean().exec(),
    )
    const mine = convo!.participants.find((p) => p.user.toString() === leaver.id)
    const theirs = convo!.participants.find((p) => p.user.toString() === buyer.id)
    expect(mine?.hidden).toBe(true)
    expect(theirs?.hidden).toBe(false)

    const { JoinRequest } = await import('../../src/features/join-request/join-request.model')
    const jr = await JoinRequest.findOne({ userId: leaver.id, organizationId: privateOrgId })
      .lean()
      .exec()
    expect(jr?.status).toBe('cancelled')

    const { Invite } = await import('../../src/features/invite/invite.model')
    const invite = await Invite.findOne({ invitedUserId: leaver.id }).lean().exec()
    expect(invite?.status).toBe('revoked')

    const { KycProfile } = await import('../../src/features/kyc/kyc.model')
    expect(await KycProfile.countDocuments({ userId: leaver.id }).exec()).toBe(0)

    // Người mua không còn thấy tin trên bảng.
    await request(app).get(`/api/v1/listings/${listingId}`).set(bearer(buyer)).expect(404)
  }, 60_000)
})
