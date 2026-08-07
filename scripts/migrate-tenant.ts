/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { Organization } from '../src/features/organization/organization.model'
import { Chain } from '../src/features/chain/chain.model'
import { Notification } from '../src/features/notification/notification.model'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { ORG_ROLES } from '../src/common/constants'

// Chạy lại được nhiều lần: mọi bước đều lọc theo "chưa có organizationId" hoặc upsert theo slug.
const DEFAULT_ORG = {
  slug: 'default',
  name: 'Default Organization',
  ownerEmail: 'owner@default.local',
  ownerPassword: 'changeme123',
}

/**
 * Vòng lặp phụ thuộc giải theo hướng ngược với luồng đăng ký: sinh orgId trước, gắn cho
 * user cũ, rồi mới chọn một user làm owner. Không cần transaction vì script chạy offline.
 */
async function ensureDefaultOrganization(): Promise<Types.ObjectId> {
  const existing = await Organization.findOne({ slug: DEFAULT_ORG.slug }).select('_id').lean()
  if (existing) return existing._id

  const orgId = new Types.ObjectId()

  const backfilled = await User.updateMany(
    { organizationId: { $exists: false } },
    { $set: { organizationId: orgId } },
  )
  console.log(`users backfilled: ${backfilled.modifiedCount}`)

  const existingOwner = await User.findOne({ organizationId: orgId })
    .select('_id')
    .lean<{ _id: Types.ObjectId } | null>()

  let ownerId = existingOwner?._id
  if (!ownerId) {
    const created = await User.create({
      organizationId: orgId,
      name: 'Default Owner',
      email: DEFAULT_ORG.ownerEmail,
      password: DEFAULT_ORG.ownerPassword,
      role: ORG_ROLES.OWNER,
    })
    ownerId = created._id
    console.log(`created default owner ${DEFAULT_ORG.ownerEmail} (đổi mật khẩu ngay)`)
  }

  await Organization.create({
    _id: orgId,
    chainId: null,
    name: DEFAULT_ORG.name,
    slug: DEFAULT_ORG.slug,
    ownerId,
  })
  console.log(`created organization ${DEFAULT_ORG.slug} (${orgId.toString()})`)

  return orgId
}

async function backfillListings(orgId: Types.ObjectId) {
  const scoped = await Listing.updateMany(
    { organizationId: { $exists: false } },
    { $set: { organizationId: orgId } },
  )
  console.log(`listings backfilled organizationId: ${scoped.modifiedCount}`)

  // Snapshot người đăng cho tin cũ: một lượt update cho mỗi seller, không N+1 theo listing.
  const sellers = await User.find({ organizationId: orgId })
    .select('_id name phone')
    .lean<{ _id: Types.ObjectId; name: string; phone?: string }[]>()

  let patched = 0
  for (const seller of sellers) {
    const result = await Listing.updateMany(
      { seller: seller._id, posterName: { $exists: false } },
      { $set: { posterName: seller.name, posterContact: seller.phone ?? '' } },
    )
    patched += result.modifiedCount
  }
  console.log(`listings backfilled poster snapshot: ${patched}`)
}

async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log('Connected. Migrating to multi-tenant...')

  await runUnscoped('tenant migration', async () => {
    const orgId = await ensureDefaultOrganization()
    await backfillListings(orgId)

    // syncIndexes vừa tạo index mới vừa DROP index không còn khai báo trong schema —
    // đúng thứ ta cần cho `email_1` (unique toàn cục cũ), text index và các index listing
    // thiếu prefix organizationId.
    // ponytail: rebuild toàn bộ index, chấp nhận được ở quy mô hiện tại; trên collection
    // production lớn thì thay bằng createIndexes/dropIndex có kiểm soát + background.
    for (const model of [User, Listing, Organization, Chain, Notification]) {
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
