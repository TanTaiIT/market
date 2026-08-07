/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { faker } from '@faker-js/faker'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { Organization } from '../src/features/organization/organization.model'
import { Chain } from '../src/features/chain/chain.model'
import { Notification } from '../src/features/notification/notification.model'
import { PlatformAdmin } from '../src/features/platform-admin/platform-admin.model'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  ORG_ROLES,
  PLATFORM_ADMIN_ROLES,
} from '../src/common/constants'

const PASSWORD = 'password123'

async function createOrgWithOwner(args: {
  name: string
  slug: string
  chainId: Types.ObjectId | null
}) {
  const orgId = new Types.ObjectId()
  const owner = await User.create({
    organizationId: orgId,
    name: `Chủ ${args.name}`,
    email: `owner@${args.slug}.local`,
    phone: faker.string.numeric({ length: 10 }),
    password: PASSWORD,
    role: ORG_ROLES.OWNER,
    isEmailVerified: true,
  })
  const org = await Organization.create({
    _id: orgId,
    chainId: args.chainId,
    name: args.name,
    slug: args.slug,
    ownerId: owner._id,
  })
  return { org, owner }
}

function buildListings(
  owner: { _id: Types.ObjectId; name: string; phone?: string },
  orgId: Types.ObjectId,
  categoryId: Types.ObjectId,
) {
  return Array.from({ length: 5 }).map(() => {
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
      seller: owner._id,
      posterName: owner.name,
      posterContact: owner.phone ?? '',
      status: LISTING_STATUS.ACTIVE,
      location: {
        type: 'Point' as const,
        coordinates: [106.7 + Math.random() * 0.1, 10.77 + Math.random() * 0.1],
        province: 'Hồ Chí Minh',
      },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  })
}

async function seed() {
  await mongoose.connect(env.MONGO_URI)
  console.log('Connected. Seeding...')

  // Toàn bộ seed chạy ngoài request nên không có tenant scope — phải khai báo tường minh.
  await runUnscoped('seed script', async () => {
    await Promise.all([
      User.deleteMany({}),
      Listing.deleteMany({}),
      Organization.deleteMany({}),
      Chain.deleteMany({}),
      Notification.deleteMany({}),
      PlatformAdmin.deleteMany({}),
    ])

    const chainId = new Types.ObjectId()
    const categoryId = new Types.ObjectId() // chưa có module category

    const hungVuong = await createOrgWithOwner({
      name: 'Trường Hùng Vương',
      slug: 'hung-vuong',
      chainId,
    })
    const caoThang = await createOrgWithOwner({
      name: 'Trường Cao Thắng',
      slug: 'cao-thang',
      chainId,
    })
    // Org độc lập: dùng để kiểm chứng user org này KHÔNG thấy tin của chain trên.
    const xyz = await createOrgWithOwner({ name: 'Cửa hàng XYZ', slug: 'xyz', chainId: null })

    await Chain.create({
      _id: chainId,
      name: 'Hệ thống Trường ABC',
      slug: 'abc-edu',
      ownerId: hungVuong.owner._id,
    })

    await Listing.insertMany([
      ...buildListings(hungVuong.owner, hungVuong.org._id, categoryId),
      ...buildListings(caoThang.owner, caoThang.org._id, categoryId),
      ...buildListings(xyz.owner, xyz.org._id, categoryId),
    ])

    await PlatformAdmin.create({
      email: 'admin@platform.local',
      name: 'Platform Super Admin',
      password: 'platform123',
      role: PLATFORM_ADMIN_ROLES.SUPER_ADMIN,
    })
  })

  console.log('Seeded: 1 chain (hung-vuong + cao-thang), 1 org độc lập (xyz), 15 listings.')
  console.log(
    `Login: POST /auth/login { orgSlug: "hung-vuong", email: "owner@hung-vuong.local", password: "${PASSWORD}" }`,
  )

  await mongoose.disconnect()
  process.exit(0)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
