/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { Membership } from '../src/features/membership/membership.model'
import { Notification } from '../src/features/notification/notification.model'

/**
 * Bật thông báo "thành viên vừa đăng tin" cho cả nhóm.
 *
 * BẮT BUỘC chạy cùng lượt deploy, vì một lý do duy nhất nhưng đủ nặng: `notificationsSeenAt`
 * mặc định `null`, và `null` nghĩa là "chưa xem gì" → mọi thông báo phát chung sinh tự động
 * đều là CHƯA ĐỌC. Không backfill thì ngay sau deploy, huy hiệu chưa-đọc của mọi thành viên
 * nhảy lên bằng số thông báo tồn kho của nhóm họ — một lần duy nhất, nhưng đúng lúc không ai
 * hiểu vì sao.
 *
 * Đặt mốc = `now` chứ không = `joinedAt`: người dùng chưa từng thấy màn thông báo ở hình dạng
 * mới, nên coi như họ đã xem hết những gì có trước hôm nay là đúng — thứ họ cần biết là tin
 * đăng TỪ GIỜ.
 *
 * Idempotent — chỉ đụng bản ghi còn `null`, chạy lại lần hai không sửa gì.
 *
 * Chạy: npm run migrate:group-notify
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  const now = new Date()
  const res = await Membership.updateMany(
    { notificationsSeenAt: null },
    { $set: { notificationsSeenAt: now } },
  ).exec()
  console.log(`Đặt mốc đã-xem cho ${res.modifiedCount}/${res.matchedCount} tư cách thành viên.`)

  /*
   * `syncIndexes` cho `Notification`: schema thêm `actorId`/`listingId`, và hộp thư giờ hỏi
   * `$or` nhiều nhóm thay vì một `organizationId` duy nhất. Index cũ
   * `{ organizationId, createdAt, unitId, userId }` vẫn phục vụ TỪNG nhánh của `$or` — không
   * thêm index mới, nhưng gọi ở đây để bộ index thật khớp đúng bộ khai trong code.
   */
  await runUnscoped('sync index thông báo', async () => {
    const before = (await Notification.collection.indexes()).map((i) => i.name)
    const dropped = await Notification.syncIndexes()
    const after = (await Notification.collection.indexes()).map((i) => i.name)
    console.log(`\nnotifications:`)
    console.log(`  trước : ${before.join(', ')}`)
    console.log(`  sau   : ${after.join(', ')}`)
    if (dropped.length > 0) console.log(`  đã gỡ : ${dropped.join(', ')}`)
  })

  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
