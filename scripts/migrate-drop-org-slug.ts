/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { Organization } from '../src/features/organization/organization.model'

/**
 * Gỡ slug khỏi tổ chức: định danh của nhóm giờ là `_id`, không còn khoá chữ nào khác.
 *
 * BẮT BUỘC chạy trước khi tạo org mới trên DB cũ: unique index `slug_1` còn đó thì org thứ hai
 * không có slug là "duplicate key" trên giá trị null — tạo org hỏng mà thông điệp không nói gì
 * về slug. Ba việc, cùng một lượt:
 *
 * 1. `syncIndexes` cho `Organization` — gỡ `slug_1`, `slugNormalized_1`, hai index không còn
 *    trong schema.
 * 2. `$unset` `slug`/`slugNormalized` khỏi mọi bản ghi — để lại là rác không ai đọc. Đi qua
 *    driver thẳng vì hai field đó đã rời schema, Mongoose sẽ lặng lẽ bỏ qua một `$unset`
 *    khai qua model.
 * 3. Drop collection `orgslugaliases` — bảng redirect 301 của slug cũ, không còn ai tra.
 *
 * **GỠ INDEX TRƯỚC, XOÁ DỮ LIỆU SAU** — đây là dòng quan trọng nhất file, và bản đầu làm ngược.
 *
 * `slug_1` là unique mà KHÔNG sparse, nên với Mongo một field vắng mặt vẫn là một khoá `null`
 * có thật. Gỡ slug khi index còn sống thì bản ghi đầu thành `null`, bản ghi thứ hai đụng ngay
 * chính nó: `E11000 dup key: { slug: null }`. `updateMany` chết giữa chừng, trước cả lệnh đáng
 * lẽ dọn cái index đó đi — script tự khoá mình.
 *
 * Chiều này thì hỏng giữa chừng cũng an toàn: gỡ index xong mà chết trước lúc `$unset` chỉ để
 * lại một field rác không ai đọc, chạy lại là xong.
 *
 * Idempotent: chạy lại khi đã sạch thì không sửa gì.
 *
 * Chạy: npm run migrate:drop-org-slug
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  // ── 1. Index TRƯỚC — xem dòng in hoa ở docblock ───────────────────────────
  const before = (await Organization.collection.indexes()).map((i) => i.name)
  const dropped = await Organization.syncIndexes()
  const after = (await Organization.collection.indexes()).map((i) => i.name)
  console.log(`organizations index — trước: ${before.join(', ')}`)
  console.log(`organizations index — sau  : ${after.join(', ')}`)
  if (dropped.length > 0) console.log(`  đã gỡ: ${dropped.join(', ')}`)

  // ── 2. Rồi mới xoá field ──────────────────────────────────────────────────
  const unset = await Organization.collection.updateMany(
    { $or: [{ slug: { $exists: true } }, { slugNormalized: { $exists: true } }] },
    { $unset: { slug: '', slugNormalized: '' } },
  )
  console.log(`organizations: gỡ slug khỏi ${unset.modifiedCount} bản ghi`)

  const db = mongoose.connection.db!
  const aliases = await db.listCollections({ name: 'orgslugaliases' }).toArray()
  if (aliases.length > 0) {
    await db.collection('orgslugaliases').drop()
    console.log('dropped collection `orgslugaliases`')
  }

  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
