/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { BannedPhrase } from '../src/features/banned-phrase/banned-phrase.model'
import { DEFAULT_BANNED_PHRASES } from '../src/features/moderation/moderation.machine'
import { userRepository } from '../src/features/user/user.repository'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { SYSTEM_ROLES } from '../src/common/constants'

/**
 * Nạp danh sách cụm cấm khởi điểm. Idempotent — upsert theo `phrase`, KHÔNG xoá gì: cụm master
 * đã thêm tay ở lại nguyên, cụm master đã GỠ khỏi danh sách mặc định thì chạy lại script sẽ
 * thêm về — nên chỉ chạy MỘT lần lúc bật tính năng, sau đó danh sách sống bằng API.
 *
 * `addedBy` là master đầu tiên tìm thấy: model bắt buộc field này để mọi cụm đều có chủ,
 * và trước lúc seed thì hệ chưa có ai khác đáng đứng tên.
 */
async function seedBannedPhrases() {
  await mongoose.connect(env.MONGO_URI)

  const grant = await RoleGrant.findOne({ role: SYSTEM_ROLES.MASTER, revokedAt: null })
    .lean()
    .exec()
  if (!grant) {
    console.error('Chưa có master nào — cấp quyền master trước rồi chạy lại.')
    await mongoose.disconnect()
    process.exit(1)
  }
  const master = await userRepository.findById(grant.userId)
  if (!master) {
    // Grant còn hiệu lực nhưng tài khoản đã xoá mềm — hook find loại nó khỏi kết quả.
    console.error('Master giữ grant đã bị xoá — cấp quyền master cho tài khoản sống rồi chạy lại.')
    await mongoose.disconnect()
    process.exit(1)
  }

  let inserted = 0
  for (const phrase of DEFAULT_BANNED_PHRASES) {
    const res = await BannedPhrase.updateOne(
      { phrase },
      { $setOnInsert: { phrase, addedBy: master._id } },
      { upsert: true },
    ).exec()
    if (res.upsertedCount > 0) inserted += 1
  }

  const total = await BannedPhrase.countDocuments().exec()
  console.log(
    `Seeded ${inserted} cụm mới (bỏ qua ${DEFAULT_BANNED_PHRASES.length - inserted} đã có). Từ điển hiện có ${total} cụm.`,
  )

  await mongoose.disconnect()
  process.exit(0)
}

seedBannedPhrases().catch((err) => {
  console.error(err)
  process.exit(1)
})
