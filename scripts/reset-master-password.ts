/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { User } from '../src/features/user/user.model'
import { roleGrantRepository } from '../src/features/role-grant/role-grant.repository'
import { assertWriteConfirmed } from './confirmWrite'

/**
 * Đổi mật khẩu MASTER — đường DUY NHẤT sau khi cửa quên-mật-khẩu công khai đóng với master
 * (audit 3.9, xem `passwordResetService.requestReset`). Cần quyền đặt biến môi trường ở nơi
 * deploy, đúng mức nghiêm trọng của việc đổi chủ hệ thống.
 *
 * Bump `tokenVersion`: đổi mật khẩu vì nghi lộ mà phiên cũ vẫn sống thì đổi để làm gì.
 */
export async function resetMasterPassword(password: string): Promise<{ userId: string }> {
  const ids = await roleGrantRepository.listActiveMasterUserIds()
  const master = await User.findOne({ _id: { $in: ids }, isActive: true })
    .select('+password')
    .exec()
  if (!master) {
    throw new Error('Không có master đăng nhập được — chạy `npm run migrate:master` trước')
  }

  master.password = password
  master.tokenVersion += 1
  // `pre('save')` băm mật khẩu — cùng đường với đăng ký và đặt lại, không tự băm ở đây.
  await master.save()
  return { userId: master._id.toString() }
}

async function main() {
  const password = process.env.MASTER_PASSWORD
  if (!password || password.length < 8) {
    throw new Error('MASTER_PASSWORD (tối thiểu 8 ký tự) là bắt buộc')
  }
  assertWriteConfirmed('reset-master-password')

  await mongoose.connect(env.MONGO_URI)
  console.log('→ đã kết nối', env.MONGO_URI.replace(/\/\/.*@/, '//***@'))

  const { userId } = await resetMasterPassword(password)
  console.log('→ đã đổi mật khẩu master', userId, '— mọi phiên cũ đã bị ngắt')
}

// Cùng chốt với `migrate-master.ts`: chỉ tự chạy khi gọi thẳng từ CLI, để test import được hàm.
if (process.argv[1]?.includes('reset-master-password')) {
  main()
    .catch((error) => {
      console.error('❌ đổi mật khẩu master thất bại:', error)
      process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
}
