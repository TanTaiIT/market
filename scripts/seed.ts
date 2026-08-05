/* eslint-disable no-console */
import mongoose from 'mongoose'
import { faker } from '@faker-js/faker'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { LISTING_STATUS, LISTING_CONDITION } from '../src/common/constants'

async function seed() {
  await mongoose.connect(env.MONGO_URI)
  console.log('Connected. Seeding...')

  await Promise.all([User.deleteMany({}), Listing.deleteMany({})])

  const seller = await User.create({
    name: 'Người bán demo',
    email: 'seller@example.com',
    phone: '0901234567',
    password: 'password123',
    isEmailVerified: true,
  })

  // Dùng ObjectId giả cho category (chưa có module category)
  const fakeCategoryId = new mongoose.Types.ObjectId()

  const listings = Array.from({ length: 10 }).map(() => ({
    title: faker.commerce.productName(),
    description: faker.commerce.productDescription(),
    price: faker.number.int({ min: 100000, max: 50000000 }),
    condition: LISTING_CONDITION.USED,
    images: [faker.image.url()],
    category: fakeCategoryId,
    seller: seller._id,
    status: LISTING_STATUS.ACTIVE,
    location: {
      type: 'Point' as const,
      coordinates: [106.7 + Math.random() * 0.1, 10.77 + Math.random() * 0.1],
      province: 'Hồ Chí Minh',
    },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }))

  await Listing.insertMany(listings)
  console.log(`Seeded 1 user + ${listings.length} listings.`)

  await mongoose.disconnect()
  process.exit(0)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
