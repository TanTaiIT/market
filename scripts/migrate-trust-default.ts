/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { UserTrust } from '../src/features/trust/trust.model'
import { INITIAL_TRUST } from '../src/features/trust/trust.policy'

/**
 * Nâng mọi hồ sơ uy tín CŨ lên mặc định mới (bậc trần) — xem `INITIAL_TRUST`.
 *
 * Vì sao phải có bước này chứ không để mặc định tự lo: mặc định chỉ áp cho người CHƯA có bản
 * ghi. Người đã đăng vài tin dưới mô hình cũ thì đã có bản ghi ở bậc 0 hoặc 1 — và sau khi
 * đổi chính sách, họ sẽ đứng THẤP HƠN một tài khoản vừa đăng ký sáng nay, dù chưa làm gì sai.
 * Đó là hạ bậc người trung thành để thưởng người lạ.
 *
 * Vì sao nâng cả người từng bị từ chối là AN TOÀN: phanh 7 ngày sau khi bị từ chối
 * (`countRecentRejections`) hoàn toàn KHÔNG đọc bậc uy tín. Người đang trong cửa sổ phạt vẫn
 * bị chặn tự đăng và vẫn bị bóp hạn mức đúng như trước — bản migration này không tha ai đang
 * chịu án, nó chỉ dọn phần bậc vốn mang nghĩa "chưa kiếm đủ" của mô hình cũ.
 *
 * `cleanApprovals` giữ nguyên: đó là lịch sử thật, và ghi đè nó chỉ để cho đẹp số.
 *
 * Idempotent — chạy lại chỉ đụng hồ sơ còn dưới trần.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)

  const res = await UserTrust.updateMany(
    { level: { $lt: INITIAL_TRUST.level } },
    { $set: { level: INITIAL_TRUST.level } },
  ).exec()

  console.log(
    `Đã nâng ${res.modifiedCount} hồ sơ uy tín lên bậc ${INITIAL_TRUST.level}. ` +
      'Án phạt 7 ngày (nếu có) không bị đụng tới.',
  )
  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
