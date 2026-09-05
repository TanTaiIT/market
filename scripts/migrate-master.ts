/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { User } from '../src/features/user/user.model'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { MASTER_DISPLAY_NAME, SCOPE_TYPES, SYSTEM_ROLES } from '../src/common/constants'

/**
 * Dựng tài khoản master — DỮ LIỆU MẶC ĐỊNH của hệ thống, không phải thứ ai cấp cho ai.
 *
 * Hệ thống có ĐÚNG MỘT master, và nó ra đời cùng lúc với database chứ không qua bất kỳ đường
 * runtime nào. Đó là lý do việc này nằm ở migration: mọi cửa khác đều là cửa sai.
 * - `POST /role-grants` đã cấm hẳn role `master` (`canGrant`).
 * - `POST /auth/bootstrap-master` đã bị gỡ: nó cho phép bất kỳ ai giữ token tạo ra master thứ
 *   hai với email tuỳ ý, tức là chính cái trần ≤1 mà quy tắc này đặt ra.
 *
 * Mật khẩu KHÔNG nằm trong repo: đọc từ `MASTER_PASSWORD`. Đặt qua biến môi trường của nơi
 * deploy (Render: Environment → Add), rồi chạy `npm run migrate:master`.
 */

/** `seedMaster` đã làm gì trong lượt vừa rồi — đủ để CLI in ra và để test soi. */
export type SeedMasterResult =
  { action: 'skipped'; usableMasters: number } | { action: 'created' | 'reused'; userId: string }

/**
 * Đảm bảo hệ thống có master — trọn một đơn vị công việc (tài khoản + grant).
 *
 * KHÔNG tự kết nối DB: tách phần đó xuống `main()` để test chạy được hàm này trên
 * `mongodb-memory-server` như mọi integration test khác. Một script đúc tài khoản quyền cao
 * nhất mà không ai chạy thử được là chỗ lỗi nằm im tới tận lúc deploy.
 *
 * KHÔNG bao giờ tạo master thứ hai: đã có master đăng nhập được thì trả `skipped` và không đụng
 * gì, kể cả khi `email` trỏ sang một người khác. Muốn đổi chủ hệ thống thì phải chạm thẳng vào
 * DB, đúng mức độ nghiêm trọng của việc đó.
 *
 * Idempotent cả khi lần trước hỏng giữa chừng: tài khoản đã tạo mà grant chưa kịp ghi thì
 * `usableMasters` vẫn là 0, lượt sau nhặt đúng tài khoản đó cấp nốt grant.
 */
export async function seedMaster(email: string, password: string): Promise<SeedMasterResult> {
  /*
   * Đếm NGƯỜI đăng nhập được, không đếm bản ghi grant: một grant còn hiệu lực trỏ vào tài khoản
   * đã xoá mềm thì hệ thống thực tế KHÔNG có master nào, và chặn ở đây sẽ khoá luôn đường dựng
   * lại. Cùng phép đếm mà chốt "phải luôn còn ít nhất một master" (§5.4) dùng.
   */
  const masterIds = await RoleGrant.distinct('userId', {
    role: SYSTEM_ROLES.MASTER,
    scopeType: SCOPE_TYPES.SYSTEM,
    revokedAt: null,
  }).exec()
  // `countDocuments` của User tự thêm `deletedAt: null` (hook `excludeDeleted`).
  const usableMasters = await User.countDocuments({
    _id: { $in: masterIds },
    isActive: true,
  }).exec()

  if (usableMasters > 0) return { action: 'skipped', usableMasters }

  /*
   * `findOne` + `save()` chứ không `updateOne`: hook băm mật khẩu nằm ở `pre('save')`, đi vòng
   * qua nó là ghi mật khẩu nguyên văn xuống DB rồi đăng nhập không bao giờ khớp.
   *
   * Không đụng tới `deletedAt`: hook `excludeDeleted` khiến `findOne` không bao giờ trả về tài
   * khoản đã xoá mềm, nên nhánh này chỉ nhận tài khoản còn sống (có thể đang bị khoá). Email
   * của tài khoản đã xoá mềm thì unique index — vốn partial trên `deletedAt: null` — cố tình
   * thả ra cho dùng lại, nên ca đó rơi xuống nhánh `create` và sinh một document mới.
   */
  const existing = await User.findOne({ email }).exec()
  let userId: string
  let action: 'created' | 'reused'

  if (existing) {
    existing.password = password
    existing.isActive = true
    await existing.save()
    userId = existing._id.toString()
    action = 'reused'
  } else {
    const created = await User.create({
      name: MASTER_DISPLAY_NAME,
      email,
      password,
      emailVerifiedAt: new Date(),
    })
    userId = created._id.toString()
    action = 'created'
  }

  /*
   * Upsert chứ không `create`: unique index `{userId, role, scopeType, orgId, unitId,
   * categoryId}` KHÔNG kèm `revokedAt`, nên mỗi bộ scope chỉ có đúng một dòng dù còn hiệu
   * lực hay đã thu hồi. `create` sẽ nổ E11000 ở ca có thật: master bị khoá (grant vẫn còn)
   * rồi chạy lại script để mở. Upsert xử trọn ba ca — chưa có thì tạo, đã thu hồi thì hồi
   * sinh, đang sống thì không đụng.
   */
  await RoleGrant.updateOne(
    { userId, role: SYSTEM_ROLES.MASTER, scopeType: SCOPE_TYPES.SYSTEM },
    { $set: { revokedAt: null, revokedBy: null } },
    { upsert: true },
  ).exec()
  return { action, userId }
}

async function main() {
  const email = env.MASTER_EMAIL?.toLowerCase().trim()
  const password = env.MASTER_PASSWORD
  if (!email || !password) {
    throw new Error('Thiếu MASTER_EMAIL hoặc MASTER_PASSWORD trong môi trường')
  }

  await mongoose.connect(env.MONGO_URI)
  console.log('→ đã kết nối', env.MONGO_URI.replace(/\/\/.*@/, '//***@'))

  const result = await seedMaster(email, password)
  if (result.action === 'skipped') {
    console.log(`→ đã có ${result.usableMasters} master đăng nhập được — không tạo thêm`)
    return
  }
  console.log(
    result.action === 'created'
      ? `→ đã tạo tài khoản ${email}`
      : '→ email đã có tài khoản — đặt lại mật khẩu và mở khoá',
  )
  console.log('→ đã cấp quyền master/system cho', result.userId)
}

/*
 * Chỉ tự chạy khi được gọi THẲNG từ CLI. Thiếu chốt này thì lượt `import { seedMaster }` của
 * test cũng kích hoạt `main()`: nó nối tới `MONGO_URI` thật rồi `disconnect()`, giật mất kết
 * nối tới mongodb-memory-server mà test đang dùng.
 */
if (process.argv[1]?.includes('migrate-master')) {
  main()
    .catch((error) => {
      console.error('❌ migrate thất bại:', error)
      process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
}
