import { Types } from 'mongoose'
import { User } from '../user/user.model'
import { EmailVerification } from './email-verification.model'
import { Favorite } from '../favorite/favorite.model'
import { JoinRequest } from '../join-request/join-request.model'
import { Membership } from '../membership/membership.model'
import { RoleGrant } from '../role-grant/role-grant.model'
import { UserTrust } from '../trust/trust.model'
import { Listing } from '../listing/listing.model'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { logger } from '../../config/logger'
import { env } from '../../config/env'

/**
 * Dọn tài khoản ĐĂNG KÝ RỒI BỎ — chưa bao giờ xác thực email.
 *
 * Vì sao cần: `register` tạo bản ghi ngay nhưng địa chỉ chưa được chứng minh là có thật. Gõ
 * nhầm một ký tự là sinh ra một tài khoản vĩnh viễn không ai vào được, mà nó vẫn GIỮ CHỖ email
 * đó (`email` unique) — người gõ nhầm quay lại đăng ký đúng địa chỉ của mình thì ăn 409 và
 * không có đường nào tự gỡ. Mỗi lượt đăng ký hỏng là một địa chỉ bị đốt.
 *
 * ── XOÁ HẲN, không `softDelete` ──
 *
 * `userService.deleteAccount` xoá mềm (đặt `deletedAt` + `isActive: false`) và GIỮ email, đúng
 * cho người dùng thật: lịch sử tin, đánh giá, hội thoại của họ phải còn tham chiếu được. Ở đây
 * ngược lại — chưa xác thực nghĩa là chưa có gì để giữ, mà giữ email lại là giữ nguyên đúng cái
 * bẫy hàm này sinh ra để gỡ. Nên đường này xoá cứng.
 *
 * ── Ba chốt an toàn ──
 *
 * 1. Chỉ đụng tài khoản THỰC SỰ trống: có quyền (`role_grants`), có tư cách thành viên, hoặc có
 *    tin đăng thì BỎ QUA và ghi cảnh báo. Ba thứ đó không thể xuất hiện trên một tài khoản chưa
 *    xác thực theo luật hiện tại (`requireVerifiedEmail` chặn đăng tin; membership và grant do
 *    người khác cấp), nên gặp là DẤU HIỆU BẤT THƯỜNG cần người nhìn, không phải rác để quét.
 * 2. Bỏ qua tài khoản có `googleId`: Google đặt `emailVerifiedAt` ngay lúc tạo nên chúng không
 *    lọt vào đây được — điều kiện này để lỡ luật đó đổi thì job không xoá nhầm.
 * 3. Mỗi lượt quét có trần (`BATCH`): job nền hỏng thì hỏng một mẻ nhỏ, không phải cả bảng.
 */

/** Hạn xác thực. Quá mốc này mà chưa nhập mã thì tài khoản bị xoá và email được trả lại. */
export const unverifiedTtlMs = () => env.UNVERIFIED_TTL_DAYS * 24 * 60 * 60 * 1000

export const unverifiedCutoff = () => new Date(Date.now() - unverifiedTtlMs())

/** Trần mỗi lượt quét — xem chốt 3 ở docblock. */
const BATCH = 200

export interface CleanupResult {
  deleted: number
  /** Tài khoản chưa xác thực nhưng CÓ tài sản — cố ý giữ lại để người nhìn. */
  skipped: number
}

/**
 * Tài khoản này có gì đáng giữ không.
 *
 * Đếm chứ không đọc bản ghi: chỉ cần biết "có hay không". `Listing` mang `tenantPlugin` nên
 * phải `runUnscoped` — job nền không đứng trong org nào, mà ở đây ta cố tình muốn nhìn XUYÊN
 * mọi org: một tin ở org bất kỳ cũng đủ để không xoá người này.
 */
async function hasAnything(userId: Types.ObjectId): Promise<boolean> {
  const [grants, memberships, listings] = await Promise.all([
    RoleGrant.countDocuments({ userId, revokedAt: null }).exec(),
    Membership.countDocuments({ userId }).exec(),
    runUnscoped('dọn tài khoản chưa xác thực: đếm tin của người này ở mọi org', () =>
      Listing.countDocuments({ seller: userId }).exec(),
    ),
  ])
  return grants > 0 || memberships > 0 || listings > 0
}

export const unverifiedCleanupService = {
  /**
   * Một lượt quét. Trả về số đã xoá và số bị bỏ qua để caller ghi log / test kiểm.
   *
   * Xoá bản ghi phụ TRƯỚC rồi mới tới `User`: không có transaction ở đây, nên thứ tự là thứ
   * quyết định trạng thái lúc hỏng giữa chừng. Dừng giữa chừng theo thứ tự này để lại một tài
   * khoản còn nguyên nhưng thiếu vài bản ghi phụ vô nghĩa — lượt quét sau dọn nốt. Thứ tự
   * ngược lại để lại đúng thứ tệ nhất: bản ghi phụ trỏ tới một `userId` không còn tồn tại.
   */
  async sweep(): Promise<CleanupResult> {
    const candidates = await User.find({
      emailVerifiedAt: null,
      googleId: null,
      createdAt: { $lte: unverifiedCutoff() },
    })
      .select('_id email')
      .limit(BATCH)
      .lean()
      .exec()

    if (candidates.length === 0) return { deleted: 0, skipped: 0 }

    let deleted = 0
    let skipped = 0

    for (const row of candidates) {
      const userId = row._id
      if (await hasAnything(userId)) {
        skipped += 1
        logger.warn('tài khoản chưa xác thực nhưng có dữ liệu — KHÔNG xoá', {
          userId: userId.toString(),
          email: row.email,
        })
        continue
      }

      await Promise.all([
        EmailVerification.deleteMany({ userId }).exec(),
        Favorite.deleteMany({ userId }).exec(),
        JoinRequest.deleteMany({ userId }).exec(),
        UserTrust.deleteMany({ userId }).exec(),
      ])
      await User.deleteOne({ _id: userId }).exec()
      deleted += 1
    }

    if (deleted > 0 || skipped > 0) {
      logger.info('dọn tài khoản chưa xác thực', {
        deleted,
        skipped,
        ttlDays: env.UNVERIFIED_TTL_DAYS,
      })
    }
    return { deleted, skipped }
  },
}
