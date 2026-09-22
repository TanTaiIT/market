/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'

/**
 * Cấp sẵn hồ sơ ĐÃ DUYỆT cho mọi tài khoản có TRƯỚC khi cổng KYC bật.
 *
 * BẮT BUỘC chạy trước lần đầu bật `KYC_REQUIRED=true`. Không chạy thì mọi tài khoản đang dùng
 * — kể cả master — rơi vào 403 ngay lượt request kế tiếp, và không ai còn cửa nào vào để duyệt
 * cho ai. Cổng tự khoá chính nó.
 *
 * Hồ sơ cấp ở đây mang `subjectType: 'individual'` và ba trường cá nhân điền từ `User.name` +
 * chỗ giữ chỗ. CHÚNG KHÔNG PHẢI DỮ LIỆU THẬT, và đó là điều phải nói thẳng: chúng chỉ giữ cho
 * hệ thống chạy tiếp, không phải thứ đem đi đối chiếu với Bộ. Tài khoản thật muốn bán hàng
 * trong giai đoạn kiểm duyệt vẫn phải tự nộp lại hồ sơ đúng.
 *
 * Idempotent: chỉ tạo cho `userId` chưa có bản ghi nào.
 *
 * Chạy: npm run kyc:grandfather
 */
const PLACEHOLDER_ID = '000000000000'

async function main() {
  await mongoose.connect(env.MONGO_URI)
  const db = mongoose.connection.db!
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  const users = await db
    .collection('users')
    .find({ deletedAt: null })
    .project({ _id: 1, name: 1 })
    .toArray()

  const kyc = db.collection('kycprofiles')
  const already = new Set((await kyc.distinct('userId', {})).map((id: unknown) => String(id)))
  const missing = users.filter((u) => !already.has(String(u._id)))

  console.log(`users: ${users.length} · đã có hồ sơ: ${already.size} · sẽ cấp: ${missing.length}`)
  if (missing.length === 0) {
    console.log('✅ không có gì để làm.')
    return
  }

  const now = new Date()
  await kyc.insertMany(
    missing.map((u) => ({
      userId: u._id,
      subjectType: 'individual',
      status: 'approved',
      fullName: String(u.name ?? 'Tài khoản cũ'),
      // Mốc giữ chỗ, KHÔNG phải ngày sinh thật — xem docblock.
      birthDate: new Date('1990-01-01'),
      idNumber: PLACEHOLDER_ID,
      reviewedBy: null,
      reviewedAt: now,
      rejectReason: null,
      createdAt: now,
      updatedAt: now,
    })),
  )

  console.log(`✅ đã cấp hồ sơ duyệt sẵn cho ${missing.length} tài khoản.`)
  console.log('   Chúng mang số định danh giữ chỗ — KHÔNG phải dữ liệu thật để đối chiếu.')
}

main()
  .catch((err) => {
    console.error('❌ thất bại:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
