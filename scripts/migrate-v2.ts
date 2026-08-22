/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { Organization } from '../src/features/organization/organization.model'
import { OrgUnit } from '../src/features/org-unit/org-unit.model'
import { Membership } from '../src/features/membership/membership.model'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { JoinRequest } from '../src/features/join-request/join-request.model'
import { UserTrust } from '../src/features/trust/trust.model'
import { Notification } from '../src/features/notification/notification.model'
import { Category } from '../src/features/category/category.model'
import {
  CategoryTemplate,
  FieldDefinition,
} from '../src/features/category-template/category-template.model'
import { upsertCatalog } from './seedCatalog'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { normalizeOrgSlug, orgNameTokens } from '../src/common/utils/orgSlug'
import { JOINED_VIA, MEMBERSHIP_ROLES, SCOPE_TYPES, SYSTEM_ROLES } from '../src/common/constants'

/**
 * Đưa dữ liệu v1 (1 user ↔ 1 org, chain, platform_admins) sang mô hình v2.
 *
 * Đọc RAW collection chứ không qua model: `users.organizationId`, `users.role`,
 * `organizations.chainId` đều đã bị xoá khỏi schema v2, nên model không còn nhìn thấy chúng —
 * mà đó chính là dữ liệu cần đọc để dựng `memberships` và `role_grants`.
 *
 * Idempotent: mọi bước đều lọc "chưa có" hoặc upsert. Chạy lại nhiều lần cho cùng kết quả.
 *
 * **Trên DB rỗng script này gần như không làm gì** — mọi bước backfill đều lọc "đã tồn tại" hoặc
 * đọc collection v1 vốn không có. Chỉ hai việc cuối còn tác dụng: upsert từ điển danh mục và
 * đồng bộ index. Muốn có dữ liệu mẫu để chạy thử thì dùng `npm run seed` (nó xoá sạch rồi dựng
 * lại), KHÔNG phải script này.
 */

interface LegacyUser {
  _id: Types.ObjectId
  email: string
  organizationId?: Types.ObjectId
  role?: string
  isEmailVerified?: boolean
}

interface LegacyOrg {
  _id: Types.ObjectId
  slug: string
  ownerId: Types.ObjectId
  slugNormalized?: string
}

async function dropChainRemnants() {
  const db = mongoose.connection.db!
  const collections = await db.listCollections().toArray()

  if (collections.some((c) => c.name === 'chains')) {
    await db.collection('chains').drop()
    console.log('dropped collection `chains`')
  }

  const unset = await db
    .collection('organizations')
    .updateMany({ chainId: { $exists: true } }, { $unset: { chainId: '' } })
  console.log(`organizations: gỡ chainId khỏi ${unset.modifiedCount} bản ghi`)

  // Thông báo cấp chain không còn khái niệm nguồn — hai field này thành rác nếu để lại.
  const notif = await db
    .collection('notifications')
    .updateMany(
      { $or: [{ sourceType: { $exists: true } }, { sourceChainId: { $exists: true } }] },
      { $unset: { sourceType: '', sourceChainId: '' } },
    )
  console.log(`notifications: gỡ sourceType/sourceChainId khỏi ${notif.modifiedCount} bản ghi`)
}

async function backfillOrgSlugNormalized() {
  const db = mongoose.connection.db!
  const orgs = await db
    .collection<LegacyOrg>('organizations')
    .find({ slugNormalized: { $exists: false } })
    .toArray()

  for (const org of orgs) {
    await db
      .collection('organizations')
      .updateOne({ _id: org._id }, { $set: { slugNormalized: normalizeOrgSlug(org.slug) } })
  }
  console.log(`organizations: dựng slugNormalized cho ${orgs.length} bản ghi`)
}

/**
 * `organizations.nameTokens` — khoá tra của dropdown chọn org.
 *
 * Bắt buộc backfill, không phải tuỳ chọn: hook `pre('validate')` chỉ chạy khi document được
 * LƯU, nên org đã có trong DB sẽ mãi thiếu field này và biến mất khỏi dropdown khi tìm theo
 * tên — im lặng, vì query vẫn chạy đúng và chỉ trả về ít hơn.
 *
 * Ghi thẳng qua driver như `slugNormalized` ở trên: `updateOne` không kích hoạt `pre('validate')`,
 * mà chạy qua model thì phải nạp rồi save từng document.
 */
async function backfillOrgNameTokens() {
  const db = mongoose.connection.db!
  const orgs = await db
    .collection<{ _id: Types.ObjectId; name: string }>('organizations')
    .find({ nameTokens: { $exists: false } })
    .toArray()

  for (const org of orgs) {
    await db
      .collection('organizations')
      .updateOne({ _id: org._id }, { $set: { nameTokens: orgNameTokens(org.name) } })
  }
  console.log(`organizations: dựng nameTokens cho ${orgs.length} bản ghi`)
}

/**
 * `users.organizationId` + `users.role` → `memberships` + `role_grants`.
 *
 * Ánh xạ quyền: `owner` cũ là người điều hành org → `manager` scope org; `moderator` cũ chỉ
 * duyệt tin → `staff` scope org. `member` không sinh grant nào: thân phận thành viên không
 * kèm quyền duyệt, đó chính là điểm tách `memberships` khỏi `role_grants`.
 */
async function backfillMemberships() {
  const db = mongoose.connection.db!
  const users = await db
    .collection<LegacyUser>('users')
    .find({ organizationId: { $exists: true } })
    .toArray()

  const orgs = await db.collection<LegacyOrg>('organizations').find({}).toArray()
  const ownerOf = new Map(orgs.map((o) => [o._id.toString(), o.ownerId?.toString()]))

  let memberships = 0
  let grants = 0

  for (const user of users) {
    const orgId = user.organizationId!
    const isOwner = ownerOf.get(orgId.toString()) === user._id.toString()

    const existing = await Membership.findOne({ userId: user._id, organizationId: orgId })
    if (!existing) {
      await Membership.create({
        userId: user._id,
        organizationId: orgId,
        role: isOwner ? MEMBERSHIP_ROLES.OWNER : MEMBERSHIP_ROLES.MEMBER,
        // Dữ liệu cũ do org nạp vào, không phải người dùng tự xin — `roster` mô tả đúng hơn
        // `request`, và mức tin cậy đi kèm cũng đúng hơn.
        joinedVia: JOINED_VIA.ROSTER,
      })
      memberships += 1
    }

    const role =
      user.role === 'owner'
        ? SYSTEM_ROLES.MANAGER
        : user.role === 'moderator'
          ? SYSTEM_ROLES.STAFF
          : null
    if (!role) continue

    const hasGrant = await RoleGrant.findOne({
      userId: user._id,
      role,
      scopeType: SCOPE_TYPES.ORG,
      orgId,
      revokedAt: null,
    })
    if (!hasGrant) {
      await RoleGrant.create({
        userId: user._id,
        role,
        scopeType: SCOPE_TYPES.ORG,
        orgId,
      })
      grants += 1
    }
  }

  console.log(`memberships: tạo ${memberships} · role_grants (org): tạo ${grants}`)
}

/** `platform_admins.super_admin` → grant `master` cho User cùng email. */
async function migratePlatformAdmins() {
  const db = mongoose.connection.db!
  const collections = await db.listCollections().toArray()
  if (!collections.some((c) => c.name === 'platform_admins' || c.name === 'platformadmins')) {
    console.log('platform_admins: không có, bỏ qua')
    return
  }

  const name = collections.some((c) => c.name === 'platformadmins')
    ? 'platformadmins'
    : 'platform_admins'
  const admins = await db
    .collection<{
      _id: Types.ObjectId
      email: string
      name: string
      password: string
      role: string
    }>(name)
    .find({})
    .toArray()

  let granted = 0
  for (const admin of admins) {
    if (admin.role !== 'super_admin') continue

    let user = await User.findOne({ email: admin.email.toLowerCase() })
    if (!user) {
      // Chèn RAW để giữ nguyên hash mật khẩu: đi qua model sẽ băm lại chuỗi đã băm và không
      // ai đăng nhập được nữa.
      const now = new Date()
      const insert = await db.collection('users').insertOne({
        name: admin.name,
        email: admin.email.toLowerCase(),
        password: admin.password,
        avatar: '',
        emailVerifiedAt: now,
        isActive: true,
        ratingAvg: 0,
        ratingCount: 0,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      user = await User.findById(insert.insertedId)
      console.log(`platform_admins: dựng User cho ${admin.email}`)
    }

    const hasMaster = await RoleGrant.findOne({
      userId: user!._id,
      role: SYSTEM_ROLES.MASTER,
      revokedAt: null,
    })
    if (!hasMaster) {
      await RoleGrant.create({
        userId: user!._id,
        role: SYSTEM_ROLES.MASTER,
        scopeType: SCOPE_TYPES.SYSTEM,
      })
      granted += 1
    }
  }
  console.log(`role_grants (master): tạo ${granted}`)
}

/**
 * Dọn field v1 khỏi `users`. Chạy CUỐI CÙNG: mọi bước trên đều đọc `organizationId`/`role`.
 * Giữ lại `organizationId` một vòng deploy để rollback được thì đổi cờ dưới đây.
 */
async function cleanupLegacyUserFields({ dropOrganizationId }: { dropOrganizationId: boolean }) {
  const db = mongoose.connection.db!

  const verified = await db
    .collection('users')
    .updateMany({ isEmailVerified: true, emailVerifiedAt: { $exists: false } }, [
      { $set: { emailVerifiedAt: '$updatedAt' } },
    ])
  console.log(`users: dựng emailVerifiedAt cho ${verified.modifiedCount} bản ghi`)

  const unset: Record<string, string> = { role: '', isEmailVerified: '' }
  if (dropOrganizationId) unset.organizationId = ''

  const cleaned = await db.collection('users').updateMany({}, { $unset: unset })
  console.log(`users: gỡ ${Object.keys(unset).join(', ')} khỏi ${cleaned.modifiedCount} bản ghi`)
}

/**
 * Tin cũ đều là tin nội bộ của một org. Gán `visibility: 'org_internal'` chứ KHÔNG phải
 * 'public': đẩy nhầm cả kho tin cũ ra trang công khai là sự cố không rút lại được.
 * `provinceCode` chép từ `location.province` — tin nội bộ không bắt buộc có tỉnh nên thiếu
 * cũng không sao.
 */
async function backfillListingAxis() {
  const db = mongoose.connection.db!

  const visibility = await db
    .collection('listings')
    .updateMany({ visibility: { $exists: false } }, { $set: { visibility: 'org_internal' } })
  console.log(`listings: gán visibility cho ${visibility.modifiedCount} bản ghi`)

  const province = await db
    .collection('listings')
    .updateMany({ provinceCode: { $exists: false } }, [
      { $set: { provinceCode: { $ifNull: ['$location.province', null] } } },
    ])
  console.log(`listings: gán provinceCode cho ${province.modifiedCount} bản ghi`)

  const unit = await db
    .collection('listings')
    .updateMany({ unitId: { $exists: false } }, { $set: { unitId: null } })
  console.log(`listings: gán unitId cho ${unit.modifiedCount} bản ghi`)

  // CỐ Ý không backfill `templateRef` và `attrs`.
  //
  // `templateRef` mang nghĩa "tin này được tạo dưới template nào". Tin v1 ra đời khi chưa có
  // template nào cả, nên gán cho nó bản chung hiện tại là ghi một điều KHÔNG đúng: form sửa tin
  // sẽ dựng đúng bộ field của bản đó và tưởng người đăng từng thấy chúng. Vắng mặt mới là câu
  // trả lời thật, và cả `listing.service` lẫn `db.ts` bên app đều đã chịu được nhánh đó.
  //
  // `attrs` là bản phẳng sinh ở service từ field `filterable`. Tin v1 không có attribute nào
  // khớp template nên bản phẳng của chúng rỗng — và mảng vắng mặt đã tương đương rỗng khi lọc.
}

async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log('Connected. Migrating to v2...')

  await runUnscoped('v2 migration', async () => {
    await dropChainRemnants()
    await backfillOrgSlugNormalized()
    await backfillOrgNameTokens()
    await backfillMemberships()
    await migratePlatformAdmins()
    await backfillListingAxis()
    // Mặc định GIỮ `organizationId`: một vòng deploy còn rollback được. Đặt `true` ở lần chạy
    // sau, khi đã chắc chắn không quay lại v1.
    await cleanupLegacyUserFields({ dropOrganizationId: false })

    // Từ điển danh mục / field / template. Đưa vào migration chứ không bắt chạy `seed:templates`
    // riêng: một DB vừa migrate mà chưa có template thì mọi lượt đăng tin đều thiếu bộ field, và
    // "nhớ chạy thêm một script nữa" là loại bước người ta quên đúng lúc đang deploy.
    //
    // An toàn trên dữ liệu thật: `upsertCatalog` chỉ upsert theo khoá tự nhiên (`slug`, `key`),
    // không xoá gì — cùng hàm mà `seed:templates` gọi. Danh mục do người vận hành tự thêm không
    // bị đụng tới.
    const catalog = await upsertCatalog()
    console.log(`catalog: ${catalog.size} danh mục + field/template đã upsert`)

    // syncIndexes vừa tạo index mới vừa DROP index không còn khai báo trong schema — đúng thứ
    // ta cần cho `(organizationId, email)` cũ và index `ownerId` unique.
    // ponytail: rebuild toàn bộ index, chấp nhận được ở quy mô hiện tại; trên collection
    // production lớn thì thay bằng createIndexes/dropIndex có kiểm soát + background.
    for (const model of [
      User,
      Organization,
      OrgUnit,
      Membership,
      RoleGrant,
      JoinRequest,
      Listing,
      UserTrust,
      Notification,
      // Ba model của cụm category-template. Thiếu chúng ở đây thì index mới (`attrs`, unique
      // `slug`/`key`, unique bản template theo danh mục) không được tạo lúc migrate — và ở
      // production `autoIndex` thường tắt, nên sẽ không có ai tạo hộ.
      Category,
      CategoryTemplate,
      FieldDefinition,
    ]) {
      const dropped = await model.syncIndexes()
      console.log(`${model.modelName}: dropped stale indexes ${JSON.stringify(dropped)}`)
    }
  })

  await mongoose.disconnect()
  console.log('Done.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
