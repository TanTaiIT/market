/* eslint-disable no-console */
import mongoose from 'mongoose'
import { hash, verify } from '@node-rs/bcrypt'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { assertDisposableDb } from './assertDisposableDb'
import { User } from '../src/features/user/user.model'

/**
 * Đặt lại mật khẩu của MỌI tài khoản về một chuỗi dùng chung, kể cả master.
 *
 * Chỉ dành cho môi trường develop, và `assertDisposableDb` là thứ ép điều đó: chạy nhầm trên
 * database thật là khoá cửa toàn bộ người dùng cùng một lúc — không có đường lùi, vì hash cũ
 * bị ghi đè chứ không được giữ lại ở đâu.
 *
 * Vì sao đụng cả master: câu hỏi là "tất cả tài khoản", và một dev database mà master còn giữ
 * mật khẩu riêng thì vẫn phải nhớ hai thứ — đúng cái phiền mà lệnh này sinh ra để dẹp. Master
 * KHÔNG bị đụng gì khác: `_id`, email và grant `master` giữ nguyên.
 *
 * Chạy: npm run migrate:password
 */

/**
 * Mật khẩu dev dùng chung. Trùng với `PASSWORD` của `seed-demo.ts` — hai file cố tình khai
 * riêng thay vì import lẫn nhau: cả hai đều gọi `main()` ở tầng module, nên import file kia là
 * CHẠY luôn script kia. Sửa một chỗ thì sửa nốt chỗ còn lại.
 */
const PASSWORD = 'abcd@1234'

/** Bằng `BCRYPT_ROUNDS` của `user.model.ts` — hash rẻ hơn ở đây là hạ bảo mật cho mọi tài khoản. */
const BCRYPT_ROUNDS = 12

async function main() {
  assertDisposableDb('migrate:password', 'đổi mật khẩu của MỌI tài khoản trên DB này')

  await mongoose.connect(env.MONGO_URI)
  const db = mongoose.connection.db!
  console.log(`Database: ${db.databaseName}`)

  /*
   * Băm MỘT lần rồi `updateMany`, không lặp `user.save()` từng người.
   *
   * Hai lý do, không phải chỉ tốc độ: `save()` chạy hook `pre('save')` vốn tự băm lại, nên gán
   * một chuỗi đã băm vào đó là băm hai lần và không mật khẩu nào đăng nhập được nữa. `updateMany`
   * đi thẳng qua driver, không kích hoạt hook — nên đây là chỗ DUY NHẤT phải tự băm.
   */
  const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS)

  /*
   * Không lọc `deletedAt: null`: hook soft-delete chỉ gắn vào `/^find/` và `countDocuments`,
   * `updateMany` không dính. Cố ý để nguyên như vậy — tài khoản đã xoá mềm mà được khôi phục
   * sau này thì cũng phải mở được bằng cùng mật khẩu, chứ không giữ một hash mồ côi.
   */
  const res = await User.updateMany({}, { $set: { password: passwordHash } })
  console.log(`Đã đổi mật khẩu ${res.modifiedCount}/${res.matchedCount} tài khoản.`)

  /*
   * Đọc lại một tài khoản thật và thử `verify` — không tin lượt ghi, tin lượt đọc.
   *
   * `password` khai `select: false` nên phải xin tường minh; quên `.select('+password')` là
   * `verify` nhận `undefined` và ném, chứ không lặng lẽ báo sai.
   */
  const sample = await User.findOne().select('+password email')
  if (!sample) {
    console.warn('Database không có tài khoản nào — không kiểm chứng được.')
  } else if (await verify(PASSWORD, sample.password)) {
    console.log(`Kiểm chứng OK: ${sample.email} đăng nhập được bằng mật khẩu mới.`)
  } else {
    throw new Error(`Ghi xong nhưng ${sample.email} KHÔNG khớp mật khẩu mới — dừng để xem lại.`)
  }

  console.log(`Mật khẩu mới cho mọi tài khoản: ${PASSWORD}`)
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
