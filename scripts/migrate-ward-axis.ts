/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { isWardOfProvince } from '../src/common/constants'

/**
 * Hạ trục danh mục xuống cấp PHƯỜNG.
 *
 * Hai việc, cố tình nằm trong một lượt vì chúng là hai nửa của cùng một thay đổi:
 *
 * 1. **Thu hồi hết grant `category_province` đang hiệu lực.** Scope cấp tỉnh vẫn tồn tại và vẫn
 *    là tầng phủ trên của cấp phường, nhưng ai phụ trách ô nào thì master cấp lại một cách có
 *    chủ ý — nở grant tỉnh cũ thành "tất cả phường của tỉnh" sẽ gán cho người ta một phạm vi họ
 *    chưa từng nhận. Bảng APPEND-ONLY nên đây là `revokedAt`, không phải xoá; `revokedBy` để
 *    `null` đúng nghĩa "migration dựng, không phải người thật thu hồi".
 *
 * 2. **Lấp `wardCode` cho tin công khai cũ.** Suy từ `location.ward` khi nó thuộc đúng
 *    `provinceCode` của tin. Tin không suy được thì để `null` và IN RA danh sách: `null` không
 *    phải trạng thái lửng lơ — `canModerateCategory` cho tầng tỉnh đỡ những tin đó, còn tầng
 *    phường thì không thấy chúng. Cần rà tay thì rà từ danh sách này.
 *
 * Đi thẳng qua driver (`connection.db`), không qua model: `tenantPlugin` sẽ đòi scope cho mọi
 * query trên `listings`, mà migration thì không có request nào để lấy scope; và validator
 * `wardCode` required-với-tin-công-khai sẽ chặn đúng những bản ghi ta đang định sửa.
 *
 * Chạy MỘT LẦN, idempotent: lượt hai không còn grant nào để thu hồi và không còn tin nào thiếu
 * `wardCode` suy được.
 */
const MAX_LISTED = 30

async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log('→ đã kết nối', env.MONGO_URI.replace(/\/\/.*@/, '//***@'))

  const db = mongoose.connection.db!

  // ── 1. Thu hồi grant cấp tỉnh ─────────────────────────────────────────────
  const revoked = await db
    .collection('rolegrants')
    .updateMany(
      { scopeType: 'category_province', revokedAt: null },
      { $set: { revokedAt: new Date() } },
    )
  console.log(`→ thu hồi ${revoked.modifiedCount} grant category_province — master cấp lại`)

  // ── 2. Lấp wardCode cho tin công khai ─────────────────────────────────────
  const rows = await db
    .collection('listings')
    .find(
      { visibility: 'public', $or: [{ wardCode: null }, { wardCode: { $exists: false } }] },
      { projection: { provinceCode: 1, 'location.ward': 1 } },
    )
    .toArray()

  const ops = []
  const needsReview: string[] = []
  for (const row of rows) {
    const province = row.provinceCode as string | null
    const ward = (row.location as { ward?: string } | undefined)?.ward?.trim()
    if (province && ward && isWardOfProvince(province, ward)) {
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: { wardCode: ward } } } })
    } else {
      needsReview.push(String(row._id))
    }
  }

  if (ops.length > 0) await db.collection('listings').bulkWrite(ops)

  console.log(`→ ${rows.length} tin công khai thiếu phường: lấp được ${ops.length}`)
  if (needsReview.length > 0) {
    console.log(`⚠️  ${needsReview.length} tin KHÔNG suy được phường — tầng tỉnh vẫn duyệt được:`)
    console.log('   ' + needsReview.slice(0, MAX_LISTED).join(', '))
    if (needsReview.length > MAX_LISTED) {
      console.log(`   … và ${needsReview.length - MAX_LISTED} tin nữa`)
    }
  }

  console.log('✅ xong')
}

migrate()
  .catch((error) => {
    console.error('❌ migrate thất bại:', error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
