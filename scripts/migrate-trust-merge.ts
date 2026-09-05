/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { UserTrust } from '../src/features/trust/trust.model'
import { CLEAN_APPROVALS_PER_LEVEL } from '../src/features/trust/trust.policy'

/**
 * Gộp uy tín hai trục về một bậc cho mỗi tài khoản.
 *
 * Trước: `memberships.trustLevel` (một bậc cho mỗi org) + `publictrusts.level` (một bậc cho mỗi
 * danh mục). Sau: `usertrusts` — một bản ghi cho mỗi người.
 *
 * Luật gộp là **lấy bậc CAO NHẤT**, không cộng dồn: cộng lại sẽ đẩy người có mặt ở nhiều org
 * lên bậc mà họ chưa từng chứng minh ở bất kỳ đâu, và bậc 2 là mốc mở quyền tự đăng — không
 * phải chỗ để rộng tay. Lấy max thì không ai mất quyền đang có, cũng không ai được thêm.
 *
 * `cleanApprovals` dựng lại từ bậc (`level × 5`) thay vì cộng chuỗi cũ: chuỗi của hai trục là
 * hai chuỗi khác nhau, nối lại không có nghĩa gì. Đặt đúng ngưỡng của bậc là trạng thái nhất
 * quán duy nhất dựng được từ dữ liệu cũ.
 *
 * Chạy MỘT LẦN, idempotent (chạy lại ra cùng kết quả). Không xoá collection cũ — giữ để đối
 * chiếu, dọn ở một lượt riêng sau khi đã yên tâm.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log('→ đã kết nối', env.MONGO_URI.replace(/\/\/.*@/, '//***@'))

  const db = mongoose.connection.db!
  const best = new Map<string, number>()
  const keepMax = (userId: unknown, level: unknown) => {
    if (!userId || typeof level !== 'number' || level <= 0) return
    const key = String(userId)
    best.set(key, Math.max(best.get(key) ?? 0, level))
  }

  // Đọc thẳng qua driver, không qua model: `Membership.trustLevel` đã bị gỡ khỏi schema nên
  // Mongoose sẽ không trả field đó nữa, còn `publictrusts` thì không còn model nào trỏ tới.
  const memberships = await db.collection('memberships').find({}).toArray()
  memberships.forEach((m) => keepMax(m.userId, m.trustLevel))

  const publicTrusts = await db.collection('publictrusts').find({}).toArray()
  publicTrusts.forEach((t) => keepMax(t.userId, t.level))

  console.log(
    `→ ${memberships.length} membership + ${publicTrusts.length} public trust ` +
      `→ ${best.size} tài khoản có bậc > 0`,
  )

  if (best.size === 0) {
    console.log('→ không có gì để gộp')
    return
  }

  // Không cần `runUnscoped`: `UserTrust` không gắn `tenantPlugin` nên không có filter tenant
  // nào để bỏ qua. Bọc vào chỉ dựng lên một cái biển "lối đi xuyên tenant" ở chỗ không có.
  const result = await UserTrust.bulkWrite(
    [...best].map(([userId, level]) => ({
      updateOne: {
        filter: { userId: new mongoose.Types.ObjectId(userId) },
        update: { $set: { level, cleanApprovals: level * CLEAN_APPROVALS_PER_LEVEL } },
        upsert: true,
      },
    })),
  )

  console.log(`✅ ghi ${result.upsertedCount} mới + ${result.modifiedCount} cập nhật`)
}

migrate()
  .catch((error) => {
    console.error('❌ migrate thất bại:', error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
