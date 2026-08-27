import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

/**
 * Fixture dùng chung cho test integration của v2.
 *
 * Dựng dữ liệu bằng đúng đường mà hệ thống thật đi: đăng ký tài khoản qua API, master tạo org
 * qua API, thành viên vào org qua membership. Chỉ hai chỗ ghi thẳng vào model — grant `master`
 * đầu tiên (test không đi qua `POST /auth/bootstrap-master` để khỏi phải dựng env token) và việc thêm thành viên hàng loạt (đường mời
 * chưa làm) — và cả hai đều là mô phỏng đúng cách vận hành thật.
 */

export const PASSWORD = 'password123'

export interface TestUser {
  token: string
  id: string
  email: string
}

/**
 * Dựng replica set, có thử lại.
 *
 * `mongodb-memory-server` tự chọn cổng trống, và với ~25 file test chạy tuần tự thì cổng của
 * instance vừa tắt còn nằm trong TIME_WAIT — lượt sau ném "getFreePort" rồi cả file bị bỏ qua.
 * Đây không phải lỗi ngẫu nhiên đáng bỏ mặc: nó khiến `npm test` đỏ mà không có bug nào.
 */
async function createReplSet(): Promise<MongoMemoryReplSet> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

export async function startTestDb(): Promise<MongoMemoryReplSet> {
  // Transaction không còn cần cho đăng ký, nhưng replica set giữ nguyên để test sát production.
  const mongod = await createReplSet()
  const uri = mongod.getUri()
  process.env.MONGO_URI = uri
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(uri)
  return mongod
}

export async function createTestApp(): Promise<Application> {
  const { createApp } = await import('../../src/app')
  return createApp()
}

export async function registerUser(app: Application, email: string, name = 'Người dùng') {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name, email, password: PASSWORD })
    .expect(201)

  return {
    token: res.body.data.tokens.accessToken as string,
    id: res.body.data.user.id as string,
    email,
  }
}

/** Master đầu tiên phải dựng thẳng vào DB — đúng như thực tế, nó do script bootstrap tạo. */
export async function makeMaster(app: Application, email = 'master@platform.local') {
  const user = await registerUser(app, email, 'Master')
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  const { SYSTEM_ROLES, SCOPE_TYPES } = await import('../../src/common/constants')

  await RoleGrant.create({
    userId: user.id,
    role: SYSTEM_ROLES.MASTER,
    scopeType: SCOPE_TYPES.SYSTEM,
  })
  return user
}

export async function createOrg(
  app: Application,
  masterToken: string,
  input: {
    name: string
    slug: string
    ownerEmail: string
    orgType?: string
    provinceCode?: string
  },
) {
  const { ownerEmail, ...body } = input
  const res = await request(app)
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${masterToken}`)
    .send(body)
    .expect(201)

  // Org sinh ra ở `pending_admin` — chưa ai vào được. Trao quyền ngay để fixture trả về một
  // org dùng được, đúng như bản cũ làm trong một lượt.
  const org = res.body.data as { id: string; slug: string; name: string }
  await request(app)
    .post(`/api/v1/organizations/${org.id}/admin`)
    .set('Authorization', `Bearer ${masterToken}`)
    .send({ email: ownerEmail })
    .expect(200)

  return org
}

/** Thêm thành viên thẳng vào DB: đường mời/roster là việc của vòng sau (§7.4). */
export async function addMember(
  userId: string,
  organizationId: string,
  opts: { unitId?: string | null; role?: string } = {},
) {
  const { Membership } = await import('../../src/features/membership/membership.model')
  const { MEMBERSHIP_ROLES, JOINED_VIA } = await import('../../src/common/constants')

  return Membership.create({
    userId,
    organizationId,
    role: opts.role ?? MEMBERSHIP_ROLES.MEMBER,
    unitId: opts.unitId ?? null,
    joinedVia: JOINED_VIA.ROSTER,
  })
}

export async function grantRole(input: {
  userId: string
  role: string
  scopeType: string
  orgId?: string
  unitId?: string
  categoryId?: string
  provinceCodes?: string[]
  wardCodes?: string[]
}) {
  const { RoleGrant } = await import('../../src/features/role-grant/role-grant.model')
  return RoleGrant.create(input)
}

/**
 * Nâng bậc uy tín để test KHÔNG về nghiệp vụ quota không bị quota chặn ngang. Bậc 1 = 5 tin
 * chờ duyệt, vẫn dưới ngưỡng tự đăng nên tin mới vẫn ở 'pending' như test mong đợi.
 */
export async function setTrustLevel(userId: string, level: number) {
  const { UserTrust } = await import('../../src/features/trust/trust.model')
  const { CLEAN_APPROVALS_PER_LEVEL } = await import('../../src/features/trust/trust.policy')
  await UserTrust.updateOne(
    { userId },
    { level, cleanApprovals: level * CLEAN_APPROVALS_PER_LEVEL },
    { upsert: true },
  ).exec()
}

/** Header chuẩn của một request có org: token + org hoạt động. */
export function orgAuth(token: string, orgSlug: string) {
  return { Authorization: `Bearer ${token}`, 'X-Org-Slug': orgSlug }
}

/** Nạp từ điển cụm cấm mặc định — cổng nội dung đọc DB, không đọc mảng hardcode nữa. */
export async function seedBannedPhrases(addedBy: string) {
  const { BannedPhrase } = await import('../../src/features/banned-phrase/banned-phrase.model')
  const { DEFAULT_BANNED_PHRASES } =
    await import('../../src/features/moderation/moderation.machine')
  await BannedPhrase.insertMany(DEFAULT_BANNED_PHRASES.map((phrase) => ({ phrase, addedBy })))
}

export async function createCategory(name = 'Đồ dùng', slug = 'do-dung') {
  const { Category } = await import('../../src/features/category/category.model')
  const category = await Category.create({ name, slug })
  return category._id.toString()
}

/** Tin mới vào PENDING và bàn duyệt là một feature khác — bật ACTIVE thẳng ở tầng model. */
export async function publishListing(listingId: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  await runUnscoped('test fixture', () =>
    Listing.updateOne({ _id: listingId }, { status: 'active' }).exec(),
  )
}

export function listingPayload(title: string, categoryId: string) {
  return {
    title,
    description: 'Mô tả đủ dài cho validation',
    price: 1000000,
    categoryId,
    images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
    location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
  }
}

/**
 * Mã nhóm của một org, tra theo slug.
 *
 * Đơn gia nhập đi bằng MÃ chứ không còn bằng slug, mà mã thì sinh ngẫu nhiên lúc tạo org nên
 * test không đoán trước được — phải hỏi DB.
 */
export async function joinCodeOf(slug: string): Promise<string> {
  const { Organization } = await import('../../src/features/organization/organization.model')
  const org = await Organization.findOne({ slug }).select('joinCode').lean().exec()
  if (!org) throw new Error(`Không có org nào slug "${slug}"`)
  return org.joinCode
}
