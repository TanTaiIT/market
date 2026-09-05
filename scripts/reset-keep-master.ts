/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { assertDisposableDb } from './assertDisposableDb'
import { SCOPE_TYPES, SYSTEM_ROLES } from '../src/common/constants'
// Nạp CẢ CỤM model: `syncIndexes` ở cuối chỉ thấy được model đã đăng ký với mongoose, và
// `routes` là barrel duy nhất kéo theo đủ 20 model qua chuỗi controller → service → repository.
import '../src/features'

/**
 * Xoá SẠCH database, giữ lại đúng MỘT tài khoản master.
 *
 * Vì sao không dùng `npm run seed`: nó vừa xoá vừa dựng lại một thế giới mẫu (trường, người
 * dùng, tin), mà việc cần ở đây là một database TRỐNG để đổ bộ dữ liệu mới vào. Và bản `seed`
 * hiện tại xoá theo DANH SÁCH MODEL VIẾT TAY — nó bỏ sót 11 collection (`Conversation`,
 * `Message`, `Favorite`, `Invite`, `Report`, `Wallet`, `XuTransaction`, `BannedPhrase`,
 * `ListingProduct`, `AuditLog`, `OrgSlugAlias`), nên "xoá sạch" của nó để lại rác trỏ vào
 * những id không còn tồn tại.
 *
 * Ở đây liệt kê collection TỪ CHÍNH DATABASE (`listCollections`), không từ code. Danh sách
 * viết tay luôn lệch khỏi hiện thực vào đúng ngày ai đó thêm một model mới; hỏi database thì
 * không có gì để quên — kể cả `publictrusts` của thế hệ cũ và `agendaJobs` của scheduler.
 *
 * Vì sao master phải sống sót: hệ thống có ĐÚNG MỘT master và nó ra đời cùng database
 * (`migrate-master.ts`). Xoá nốt nó là tự khoá mình ngoài cửa — không endpoint runtime nào
 * tạo lại được master, kể cả `POST /role-grants` (đã cấm hẳn role này).
 *
 * Chạy: npm run reset:keep-master
 */

/** Xoá dữ liệu nhưng GIỮ collection + index: `drop()` gỡ luôn index rồi phải dựng lại từ đầu. */
const WIPE_EXCLUDE = new Set(['system.views'])

async function main() {
  await mongoose.connect(env.MONGO_URI)
  const db = mongoose.connection.db!

  // Chốt an toàn ĐỨNG SAU connect nhưng TRƯỚC mọi lượt ghi — `market-pro`/`market` bị chặn cứng.
  assertDisposableDb('reset:keep-master')
  console.log(`Database: ${db.databaseName}`)

  /*
   * Tìm master TRƯỚC khi xoá, và dừng hẳn nếu không có.
   *
   * Đếm qua `RoleGrant` chứ không qua một cờ trên `User`: quyền master sống ở `role_grants`,
   * và đó cũng là phép đếm mà `seedMaster` dùng. Đọc bằng driver thô để bỏ qua hook soft-delete
   * — kể cả master đã bị xoá mềm cũng phải nhìn thấy, nếu không script sẽ tưởng không có ai.
   */
  const grants = await db
    .collection('rolegrants')
    .find({ role: SYSTEM_ROLES.MASTER, scopeType: SCOPE_TYPES.SYSTEM, revokedAt: null })
    .toArray()

  const users = await db
    .collection('users')
    .find({ _id: { $in: grants.map((g) => g.userId) } })
    .toArray()

  if (users.length === 0) {
    throw new Error(
      'Không tìm thấy tài khoản master nào — DỪNG, không xoá gì.\n' +
        'Xoá sạch mà không giữ được master là tự khoá mình ngoài hệ thống: không endpoint nào ' +
        'tạo lại master được. Chạy `npm run migrate:master` trước rồi chạy lại lệnh này.',
    )
  }

  /*
   * Nhiều master thì giữ NGƯỜI VÀO TRƯỚC.
   *
   * Đáng lẽ hệ thống chỉ có một (`seedMaster` từ chối tạo cái thứ hai), nên nhiều hơn một là dấu
   * hiệu dữ liệu dev đã lẫn. Chọn theo `_id` tăng dần cho kết quả ổn định giữa các lần chạy —
   * chứ không phải "cái nào driver trả trước".
   */
  const keep = users.sort((a, b) => String(a._id).localeCompare(String(b._id)))[0]
  const keepGrant = grants.find((g) => String(g.userId) === String(keep._id))!
  if (users.length > 1) {
    console.warn(`⚠️  Có ${users.length} master — giữ lại ${keep.email}, các tài khoản kia bị xoá.`)
  }
  console.log(`Giữ master: ${keep.email} (${String(keep._id)})`)

  const names = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !WIPE_EXCLUDE.has(n))
    .sort()

  let removed = 0
  for (const name of names) {
    const { deletedCount } = await db.collection(name).deleteMany({})
    removed += deletedCount
    if (deletedCount > 0) console.log(`  ${String(deletedCount).padStart(7)}  ${name}`)
  }
  console.log(`Đã xoá ${removed} document trên ${names.length} collection.`)

  /*
   * Ghi lại master NGUYÊN VẸN, giữ cả `_id` và hash mật khẩu.
   *
   * `insertOne` bằng driver thô, không phải `User.create`: hook `pre('save')` sẽ băm lại chuỗi
   * `password` vốn ĐÃ là hash, và mật khẩu cũ vĩnh viễn không đăng nhập được nữa.
   */
  await db.collection('users').insertOne(keep)
  await db.collection('rolegrants').insertOne(keepGrant)
  console.log('Đã khôi phục master + quyền master.')

  /*
   * `syncIndexes` cho MỌI model, không chỉ tạo index mới mà còn GỠ index cũ đã bỏ khỏi code.
   * Bỏ bước này thì một unique index của thế hệ trước còn sống và sẽ chặn dữ liệu hợp lệ của
   * bộ seed mới — lỗi nổ ra giữa mẻ, lúc không ai biết đã ghi tới đâu.
   */
  const models = mongoose.modelNames()
  for (const name of models) await mongoose.model(name).syncIndexes()
  console.log(`Đã đồng bộ index cho ${models.length} model.`)

  await mongoose.disconnect()
  console.log('Xong. Database trống, còn đúng một tài khoản master.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
