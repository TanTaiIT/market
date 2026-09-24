/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { User } from '../src/features/user/user.model'
import { AXIS_LABEL, axisOf, type GrantAxis } from '../src/common/constants'

/**
 * Soi dữ liệu ĐANG CÓ: ai đang đứng trên CẢ HAI trục duyệt cùng lúc.
 *
 * `assertSingleAxis` chỉ chặn từ nay trở đi — nó không sửa được những lượt cấp đã xảy ra trước
 * khi có chốt. Script này tìm ra chúng để master đi thu hồi bớt một bên.
 *
 * CHỈ ĐỌC, cố ý. Không có lựa chọn tự động nào đúng: giữ trục nào và bỏ trục nào là quyết định
 * vận hành — bỏ nhầm quyền nhóm có thể lấy đi quản trị cuối cùng của một nhóm đang chạy, và
 * chốt chặn việc đó nằm ở `roleGrantService.revoke`, nơi một script sửa hàng loạt sẽ đi vòng qua.
 */
async function check() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  // `role_grants` không mang `tenantPlugin` (quyền là của TÀI KHOẢN, toàn cục) nên đọc thẳng.
  const grants = await RoleGrant.find({ revokedAt: null }).select('userId scopeType').lean().exec()

  /** userId → những trục người đó đang giữ. `system` rơi khỏi đây vì `axisOf` trả `null`. */
  const axesByUser = new Map<string, Set<GrantAxis>>()
  for (const grant of grants) {
    const axis = axisOf(grant.scopeType)
    if (!axis) continue
    const key = grant.userId.toString()
    const held = axesByUser.get(key) ?? new Set<GrantAxis>()
    held.add(axis)
    axesByUser.set(key, held)
  }

  const offenders = [...axesByUser.entries()].filter(([, axes]) => axes.size > 1)

  if (offenders.length === 0) {
    console.log(`✅ ${axesByUser.size} tài khoản có quyền trục, không ai đứng trên cả hai.`)
    await mongoose.disconnect()
    process.exit(0)
  }

  console.log(`❌ ${offenders.length}/${axesByUser.size} tài khoản đang đứng trên CẢ HAI trục:`)

  const users = await User.find({ _id: { $in: offenders.map(([id]) => id) } })
    .select('name email')
    .lean()
    .exec()
  const byId = new Map(users.map((u) => [u._id.toString(), u]))

  for (const [userId, axes] of offenders) {
    // Tài khoản xoá mềm vẫn giữ grant (xoá tài khoản KHÔNG thu hồi quyền), và model `User` có
    // hook lọc `deletedAt` — nên vắng mặt ở đây nghĩa là đã xoá, không phải id sai.
    const user = byId.get(userId)
    const held = [...axes].map((a) => AXIS_LABEL[a]).join(' + ')
    console.log(`   · ${user?.name ?? 'Tài khoản không còn'} <${user?.email ?? '—'}> — ${held}`)
    console.log(`     userId=${userId}`)
  }

  console.log('\nSửa: xem quyền của từng người rồi thu hồi bớt MỘT trục.')
  console.log('  GET    /api/v1/role-grants/category-axis   — bảng ai phụ trách danh mục nào')
  console.log('  DELETE /api/v1/role-grants/<grantId>       — thu hồi (chốt an toàn vẫn chạy)')

  await mongoose.disconnect()
  process.exit(1)
}

check().catch((err) => {
  console.error(err)
  process.exit(1)
})
