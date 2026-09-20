/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { LISTING_REACH } from '../src/common/constants'

/**
 * `visibility` (2 giá trị) → `reach` (thang 3 bậc).
 *
 * ```
 * org_internal → members
 * public       → marketplace
 * ```
 *
 * **MIGRATION KHÔNG BAO GIỜ NỚI TẦM NHÌN.** Đây là dòng quan trọng nhất file.
 *
 * Sẽ rất cám dỗ khi "tối ưu" chỗ này: tin `org_internal` của một nhóm ĐANG công khai thì nâng
 * thẳng lên `group_open` cho khớp mặc định mới. Đừng. Những tin đó được đăng dưới lời hứa "chỉ
 * thành viên nhóm đọc được", và người đăng không có mặt ở đây để đổi ý. Bậc `group_open` chỉ
 * dành cho tin đăng TỪ SAU thay đổi này; tin cũ muốn mở thì chính chủ tự mở.
 *
 * Đi thẳng qua driver (`connection.db`), không qua model — cùng lý do với `migrate-ward-axis`:
 * `tenantPlugin` đòi scope cho mọi query trên `listings` mà migration không có request nào để
 * lấy scope, và validator `reach` required sẽ chặn đúng những bản ghi ta đang định sửa.
 *
 * GIỮ NGUYÊN `visibility` sau khi ghi `reach` — đường lùi. Dọn ở một lượt riêng, sau khi đã
 * chắc chắn không quay lại.
 *
 * Idempotent: lượt hai không còn bản ghi nào thiếu `reach`.
 *
 * Chạy: npm run migrate:listing-reach
 * Sau đó: npm run sync-indexes  (xem rồi mới `-- --apply`)
 */
const MAX_LISTED = 30

async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  const listings = mongoose.connection.db!.collection('listings')

  // ── 0. Soi trước, đừng đoán ───────────────────────────────────────────────
  const [total, hasReach, orgInternal, publicAxis, orphan] = await Promise.all([
    listings.countDocuments({}),
    listings.countDocuments({ reach: { $exists: true } }),
    listings.countDocuments({ visibility: 'org_internal' }),
    listings.countDocuments({ visibility: 'public' }),
    listings.countDocuments({ visibility: { $exists: false }, reach: { $exists: false } }),
  ])

  console.log(`listings: ${total} tin · đã có reach: ${hasReach}`)
  console.log(`  org_internal → members     : ${orgInternal}`)
  console.log(`  public       → marketplace : ${publicAxis}`)

  /*
   * Bản ghi không có CẢ HAI field là thứ không giải thích được bằng dữ liệu v1 lẫn v2. Dừng
   * thay vì đoán: gán bừa một bậc cho chúng là hoặc giấu tin của ai đó, hoặc lộ tin của ai đó.
   */
  if (orphan > 0) {
    throw new Error(
      `${orphan} tin không có cả \`visibility\` lẫn \`reach\` — rà tay trước, migration không đoán`,
    )
  }

  // ── 1. Hai lượt ghi, chỉ chạm bản ghi CHƯA có `reach` ─────────────────────
  const toMembers = await listings.updateMany(
    { visibility: 'org_internal', reach: { $exists: false } },
    { $set: { reach: LISTING_REACH.MEMBERS } },
  )
  const toMarketplace = await listings.updateMany(
    { visibility: 'public', reach: { $exists: false } },
    { $set: { reach: LISTING_REACH.MARKETPLACE } },
  )
  console.log(`→ members: ${toMembers.modifiedCount} · marketplace: ${toMarketplace.modifiedCount}`)

  // ── 2. Di sản v1: không `visibility`, nhưng CÓ `reach` thì đã xong ở lượt trước ──
  const legacy = await listings
    .find({ visibility: { $exists: false }, reach: { $exists: false } })
    .project({ _id: 1 })
    .toArray()
  if (legacy.length > 0) {
    // Bậc THẤP NHẤT cho thứ không biết rõ — cùng nguyên tắc với dòng in hoa ở docblock.
    await listings.updateMany(
      { visibility: { $exists: false }, reach: { $exists: false } },
      { $set: { reach: LISTING_REACH.MEMBERS } },
    )
    const ids = legacy.map((d) => d._id.toString())
    console.log(`⚠️  ${ids.length} tin di sản không có visibility → đặt \`members\`:`)
    console.log('   ' + ids.slice(0, MAX_LISTED).join(', '))
    if (ids.length > MAX_LISTED) console.log(`   … và ${ids.length - MAX_LISTED} tin nữa`)
  }

  /*
   * ── 3. Báo cáo, KHÔNG sửa ────────────────────────────────────────────────
   * Bao nhiêu tin `members` đang nằm dưới một nhóm công khai — tức là bao nhiêu tin mà chính
   * chủ CÓ THỂ muốn mở ra `group_open`. In con số để sản phẩm biết độ lớn của việc đó; quyết
   * định thì thuộc về từng người đăng, không thuộc về script này.
   */
  const publicOrgIds = await mongoose.connection
    .db!.collection('organizations')
    .distinct('_id', { isPublic: { $ne: false }, deletedAt: null })
  const openable = await listings.countDocuments({
    reach: LISTING_REACH.MEMBERS,
    organizationId: { $in: publicOrgIds },
  })
  console.log(`ℹ️  ${openable} tin \`members\` đang ở nhóm công khai — chính chủ tự mở nếu muốn.`)

  console.log('\n✅ xong. `visibility` được GIỮ LẠI làm đường lùi.')
  console.log('   Bước tiếp: npm run sync-indexes   (xem rồi mới thêm -- --apply)')
}

migrate()
  .catch((error) => {
    console.error('❌ migrate thất bại:', error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
