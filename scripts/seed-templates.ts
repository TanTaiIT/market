/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { upsertCatalog, CATEGORIES, FIELD_DEFS, TEMPLATES } from './seedCatalog'

/**
 * Cập nhật từ điển danh mục / field / template.
 *
 * KHÔNG gọi `assertDisposableDb`, khác `seed.ts`: script này không xoá gì cả, chỉ upsert theo
 * khoá tự nhiên. Chạy được trên môi trường đang có dữ liệu thật — mà đó chính là cách một
 * template mới lên production.
 */
async function seedTemplates() {
  await mongoose.connect(env.MONGO_URI)

  await upsertCatalog()

  const withTemplate = TEMPLATES.filter((t) => t.slug !== null).length
  console.log(
    `Seeded: ${FIELD_DEFS.length} field, ${CATEGORIES.length} danh mục, ` +
      `${withTemplate} template riêng + 1 bản chung.`,
  )
  console.log(
    `Danh mục chưa có template riêng sẽ dùng bản chung (4 field) — đúng thiết kế, không phải lỗi.`,
  )

  await mongoose.disconnect()
  process.exit(0)
}

seedTemplates().catch((err) => {
  console.error(err)
  process.exit(1)
})
