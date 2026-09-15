/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { User } from '../src/features/user/user.model'

/**
 * Miễn xác thực email cho MỌI tài khoản đã tồn tại — chạy MỘT LẦN, ngay trước khi bật
 * `requireVerifiedEmail`.
 *
 * Vì sao bắt buộc phải có bước này: luồng xác thực email ra đời sau, nên `emailVerifiedAt`
 * của mọi tài khoản mật khẩu đang là `null` — kể cả người đã đăng hàng chục tin từ nhiều
 * tháng trước. Bật chốt mà không chạy script này là **cắt quyền đăng tin và nhắn tin của
 * toàn bộ người dùng hiện có cùng lúc**, và họ chỉ lấy lại được sau khi mở hộp thư nhập mã —
 * với điều kiện thư xác thực tới được hộp thư của họ. Đó là một sự cố tự gây, không phải một đợt siết.
 *
 * Mốc lấy `createdAt` của chính tài khoản, KHÔNG phải `new Date()`: cột này có nghĩa là
 * "thời điểm hệ thống có bằng chứng về hộp thư". Ghi hôm nay cho một tài khoản mở từ tháng
 * trước là bịa ra một mốc chưa từng xảy ra — mà cột này còn dùng để tra cứu về sau.
 *
 * Tài khoản Google đã có `emailVerifiedAt` từ lượt đăng nhập đầu nên không lọt vào bộ lọc.
 *
 * Idempotent: chạy lại chỉ đụng tài khoản còn `null`. Người đăng ký SAU lượt chạy này vẫn
 * phải tự xác thực như thiết kế.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)

  const cutoff = new Date()
  const res = await User.updateMany({ emailVerifiedAt: null }, [
    { $set: { emailVerifiedAt: '$createdAt' } },
  ]).exec()

  console.log(
    `Đã miễn xác thực cho ${res.modifiedCount} tài khoản tạo trước ${cutoff.toISOString()}. ` +
      'Người đăng ký sau mốc này vẫn phải nhập mã.',
  )
  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
