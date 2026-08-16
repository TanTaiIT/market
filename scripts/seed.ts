/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { faker } from '@faker-js/faker'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { Organization } from '../src/features/organization/organization.model'
import { OrgUnit } from '../src/features/org-unit/org-unit.model'
import { Membership } from '../src/features/membership/membership.model'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { JoinRequest } from '../src/features/join-request/join-request.model'
import { PublicTrust } from '../src/features/trust/trust.model'
import { Notification } from '../src/features/notification/notification.model'
import { Category } from '../src/features/category/category.model'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { assertDisposableDb } from './assertDisposableDb'
import {
  JOINED_VIA,
  LISTING_STATUS,
  LISTING_CONDITION,
  POST_VISIBILITY,
  MEMBERSHIP_ROLES,
  ORG_CAPABILITY_PRESETS,
  ORG_TYPES,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  wardsOf,
} from '../src/common/constants'

const PASSWORD = 'password123'

/**
 * Dựng org theo đúng đường mà `organizationService.createByMaster` đi: org + membership `owner`
 * + grant `manager` scope org. Thiếu grant thì chủ org không duyệt được gì trong org của mình,
 * và fixture sẽ mô tả sai cách hệ thống thật hoạt động.
 */
async function createOrg(args: {
  name: string
  slug: string
  orgType: (typeof ORG_TYPES)[keyof typeof ORG_TYPES]
  provinceCode: string
  masterId: Types.ObjectId
  units?: string[]
}) {
  const owner = await User.create({
    name: `Chủ ${args.name}`,
    email: `owner@${args.slug}.local`,
    phone: faker.string.numeric({ length: 10 }),
    password: PASSWORD,
    emailVerifiedAt: new Date(),
  })

  const org = await Organization.create({
    name: args.name,
    slug: args.slug,
    orgType: args.orgType,
    capabilities: ORG_CAPABILITY_PRESETS[args.orgType],
    provinceCode: args.provinceCode,
    ownerId: owner._id,
    createdBy: args.masterId,
  })

  await Membership.create({
    userId: owner._id,
    organizationId: org._id,
    role: MEMBERSHIP_ROLES.OWNER,
    joinedVia: JOINED_VIA.ROSTER,
  })

  await RoleGrant.create({
    userId: owner._id,
    role: SYSTEM_ROLES.MANAGER,
    scopeType: SCOPE_TYPES.ORG,
    orgId: org._id,
    grantedBy: args.masterId,
  })

  const units = await OrgUnit.insertMany(
    (args.units ?? []).map((name) => ({ organizationId: org._id, name })),
  )

  // Một thành viên thường + staff của nhóm đầu tiên, để thử được lớp duyệt phân tầng.
  const member = await User.create({
    name: faker.person.fullName(),
    email: `member@${args.slug}.local`,
    phone: faker.string.numeric({ length: 10 }),
    password: PASSWORD,
    emailVerifiedAt: new Date(),
  })
  await Membership.create({
    userId: member._id,
    organizationId: org._id,
    role: MEMBERSHIP_ROLES.MEMBER,
    unitId: units[0]?._id ?? null,
    joinedVia: JOINED_VIA.REQUEST,
  })

  if (units[0]) {
    const staff = await User.create({
      name: faker.person.fullName(),
      email: `staff@${args.slug}.local`,
      password: PASSWORD,
      emailVerifiedAt: new Date(),
    })
    await Membership.create({
      userId: staff._id,
      organizationId: org._id,
      role: MEMBERSHIP_ROLES.MEMBER,
      unitId: units[0]._id,
      joinedVia: JOINED_VIA.ROSTER,
    })
    await RoleGrant.create({
      userId: staff._id,
      role: SYSTEM_ROLES.STAFF,
      scopeType: SCOPE_TYPES.ORG_UNIT,
      orgId: org._id,
      unitId: units[0]._id,
      grantedBy: args.masterId,
    })
  }

  return { org, owner, member }
}

function buildListings(
  seller: { _id: Types.ObjectId; name: string; phone?: string },
  orgId: Types.ObjectId,
  categoryId: Types.ObjectId,
) {
  // Rải qua 4 xã đầu của TP.HCM thay vì dồn hết một chỗ: `/listings/nearby` xếp tin cùng xã
  // lên trước, fixture mà chung một xã thì không thấy được thứ tự đó có chạy hay không.
  return Array.from({ length: 5 }).map((_, index) => {
    const title = faker.commerce.productName()
    return {
      organizationId: orgId,
      title,
      slug: `${faker.helpers.slugify(title).toLowerCase()}-${faker.string.alphanumeric(6)}`,
      description: faker.commerce.productDescription(),
      price: faker.number.int({ min: 100000, max: 50000000 }),
      condition: LISTING_CONDITION.USED,
      images: [faker.image.url()],
      category: categoryId,
      seller: seller._id,
      posterName: seller.name,
      posterContact: seller.phone ?? '',
      visibility: POST_VISIBILITY.ORG_INTERNAL,
      provinceCode: 'Hồ Chí Minh',
      status: LISTING_STATUS.ACTIVE,
      location: {
        province: 'Hồ Chí Minh' as const,
        ward: wardsOf('Hồ Chí Minh')[index % 4],
      },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  })
}

async function seed() {
  // Trước cả `connect`: chốt phải chặn từ lúc chưa đụng gì tới DB.
  assertDisposableDb('seed')

  await mongoose.connect(env.MONGO_URI)
  console.log('Connected. Seeding...')

  // Toàn bộ seed chạy ngoài request nên không có tenant scope — phải khai báo tường minh.
  await runUnscoped('seed script', async () => {
    await Promise.all([
      User.deleteMany({}),
      Listing.deleteMany({}),
      Organization.deleteMany({}),
      OrgUnit.deleteMany({}),
      Membership.deleteMany({}),
      RoleGrant.deleteMany({}),
      JoinRequest.deleteMany({}),
      PublicTrust.deleteMany({}),
      Notification.deleteMany({}),
      Category.deleteMany({}),
    ])

    // Danh mục là từ điển dùng chung, không thuộc org nào — khớp bốn chip lọc bên app mobile.
    const categories = await Category.insertMany([
      { name: 'Sách vở', slug: 'sach-vo', icon: '📚', order: 1 },
      { name: 'Xe đạp', slug: 'xe-dap', icon: '🚲', order: 2 },
      { name: 'Điện tử', slug: 'dien-tu', icon: '💻', order: 3 },
      { name: 'Đồ dùng', slug: 'do-dung', icon: '🎒', order: 4 },
    ])
    const categoryId = categories[0]._id

    // Master là một User bình thường + một grant scope `system`. Không còn collection riêng.
    const master = await User.create({
      name: 'Platform Master',
      email: 'master@platform.local',
      password: 'platform123',
      emailVerifiedAt: new Date(),
    })
    await RoleGrant.create({
      userId: master._id,
      role: SYSTEM_ROLES.MASTER,
      scopeType: SCOPE_TYPES.SYSTEM,
    })

    const hungVuong = await createOrg({
      name: 'Trường Hùng Vương',
      slug: 'hung-vuong',
      orgType: ORG_TYPES.SCHOOL,
      provinceCode: 'Hồ Chí Minh',
      masterId: master._id,
      units: ['10A1', '10A2'],
    })
    const caoThang = await createOrg({
      name: 'Trường Cao Thắng',
      slug: 'cao-thang',
      orgType: ORG_TYPES.SCHOOL,
      provinceCode: 'Hồ Chí Minh',
      masterId: master._id,
      units: ['11B1'],
    })
    // Org phẳng: không có nhóm con, để kiểm chứng lớp duyệt phân tầng tự suy biến đúng.
    const xyz = await createOrg({
      name: 'Cửa hàng XYZ',
      slug: 'xyz',
      orgType: ORG_TYPES.GENERIC,
      provinceCode: 'Hà Nội',
      masterId: master._id,
    })

    await Listing.insertMany([
      ...buildListings(hungVuong.owner, hungVuong.org._id, categoryId),
      ...buildListings(caoThang.owner, caoThang.org._id, categoryId),
      ...buildListings(xyz.owner, xyz.org._id, categoryId),
    ])

    // Một manager danh mục cho trục công khai (Phase 4 dùng tới) — TP.HCM, danh mục "Sách vở".
    const catManager = await User.create({
      name: 'Quản lý danh mục Sách vở',
      email: 'catmanager@platform.local',
      password: PASSWORD,
      emailVerifiedAt: new Date(),
    })
    await RoleGrant.create({
      userId: catManager._id,
      role: SYSTEM_ROLES.MANAGER,
      scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
      categoryId,
      provinceCodes: ['Hồ Chí Minh'],
      grantedBy: master._id,
    })
  })

  console.log('Seeded: 4 danh mục, 3 org (2 trường có nhóm con + 1 org phẳng), 15 listings.')
  console.log(`Master:      master@platform.local / platform123`)
  console.log(`Chủ org:     owner@hung-vuong.local / ${PASSWORD}`)
  console.log(`Thành viên:  member@hung-vuong.local / ${PASSWORD}`)
  console.log('Đăng nhập: POST /api/v1/auth/login { email, password } — không cần orgSlug nữa.')
  console.log('Gọi API của org: thêm header `X-Org-Slug: hung-vuong`.')

  await mongoose.disconnect()
  process.exit(0)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
