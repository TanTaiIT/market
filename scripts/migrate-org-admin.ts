/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { MEMBERSHIP_ROLES } from '../src/common/constants'
import { generateJoinCode } from '../src/common/utils/joinCode'

/**
 * Đổi cách biểu diễn "người phụ trách org".
 *
 * Trước: ba thứ cùng nói một điều — `organizations.ownerId`, `memberships.role = 'owner'`, và
 * một `role_grant` scope org. Sau: chỉ còn hai, và mỗi cái một việc — `memberships.role =
 * 'admin'` là thân phận, `role_grants` là quyền. `ownerId` bị gỡ vì không dòng code nào từng
 * đọc nó.
 *
 * Bắt buộc chạy trước khi deploy: bản ghi còn `role: 'owner'` sẽ rớt khỏi enum mới, và danh bạ
 * thành viên (`GET /memberships`) sẽ trả 500 khi gặp nó.
 *
 * Cấp luôn mã nhóm cho org cũ: field `joinCode` là bắt buộc và unique, org không có mã thì mọi
 * lượt `save()` sau này đều rớt validation.
 *
 * Idempotent. Chạy: `npm run migrate:org-admin`
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log('→ đã kết nối', env.MONGO_URI.replace(/\/\/.*@/, '//***@'))

  const db = mongoose.connection.db!

  const roles = await db
    .collection('memberships')
    .updateMany({ role: 'owner' }, { $set: { role: MEMBERSHIP_ROLES.ADMIN } })
  console.log(`→ ${roles.modifiedCount} membership đổi 'owner' → 'admin'`)

  const owners = await db
    .collection('organizations')
    .updateMany({ ownerId: { $exists: true } }, { $unset: { ownerId: '' } })
  console.log(`→ ${owners.modifiedCount} organization gỡ 'ownerId'`)

  // Org không có ai giữ role_grant scope org = org vô chủ. Đẩy về `pending_admin` để nó không
  // nhận đơn và không nhận tin trong lúc chưa ai trông — đúng trạng thái mà bản mới định nghĩa.
  const orgIds = await db.collection('organizations').distinct('_id', { status: 'active' })
  const managed = await db
    .collection('rolegrants')
    .distinct('orgId', { scopeType: 'org', revokedAt: null })
  const managedSet = new Set(managed.map((id) => String(id)))
  const orphan = orgIds.filter((id) => !managedSet.has(String(id)))

  if (orphan.length > 0) {
    await db
      .collection('organizations')
      .updateMany({ _id: { $in: orphan } }, { $set: { status: 'pending_admin' } })
  }
  console.log(`→ ${orphan.length} organization chưa có người phụ trách → 'pending_admin'`)

  // Mã nhóm: org cũ chưa có, mà field là bắt buộc. Sinh từng cái một và thử lại khi đụng —
  // unique index là trọng tài, y như đường tạo org mới.
  const codeless = await db.collection('organizations').find({ joinCode: null }).toArray()
  for (const org of codeless) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db
          .collection('organizations')
          .updateOne({ _id: org._id }, { $set: { joinCode: generateJoinCode() } })
        break
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err
      }
    }
  }
  console.log(`→ ${codeless.length} organization được cấp mã nhóm`)
}

migrate()
  .catch((error) => {
    console.error('❌ migrate thất bại:', error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
