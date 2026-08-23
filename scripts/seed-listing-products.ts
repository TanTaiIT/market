/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { ListingProduct } from '../src/features/listing-product/listing-product.model'
import { DEFAULT_LISTING_PRODUCTS } from '../src/features/listing/listing.pricing'
import { userRepository } from '../src/features/user/user.repository'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { SYSTEM_ROLES } from '../src/common/constants'

/**
 * Nạp bộ gói tin khởi điểm (nháp, chưa giá). Idempotent — upsert theo `code`, `$setOnInsert`
 * nên gói master đã sửa/bật qua API ở lại nguyên; chỉ chạy MỘT lần lúc bật tính năng,
 * sau đó catalog sống bằng API /listing-products. Cùng khuôn với seed-banned-phrases.
 */
async function seedListingProducts() {
  await mongoose.connect(env.MONGO_URI)

  const grant = await RoleGrant.findOne({ role: SYSTEM_ROLES.MASTER, revokedAt: null })
    .lean()
    .exec()
  if (!grant) {
    console.error('Chưa có master nào — cấp quyền master trước rồi chạy lại.')
    await mongoose.disconnect()
    process.exit(1)
  }
  const master = await userRepository.findById(grant.userId)
  if (!master) {
    console.error('Master giữ grant đã bị xoá — cấp quyền master cho tài khoản sống rồi chạy lại.')
    await mongoose.disconnect()
    process.exit(1)
  }

  let inserted = 0
  for (const product of DEFAULT_LISTING_PRODUCTS) {
    const res = await ListingProduct.updateOne(
      { code: product.code },
      { $setOnInsert: { ...product, createdBy: master._id } },
      { upsert: true },
    ).exec()
    if (res.upsertedCount > 0) inserted += 1
  }

  const total = await ListingProduct.countDocuments().exec()
  console.log(
    `Seeded ${inserted} gói mới (bỏ qua ${DEFAULT_LISTING_PRODUCTS.length - inserted} đã có). Catalog hiện có ${total} gói.`,
  )

  await mongoose.disconnect()
  process.exit(0)
}

seedListingProducts().catch((err) => {
  console.error(err)
  process.exit(1)
})
