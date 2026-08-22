import { IMembershipDocument } from './membership.model'
import { IUserDocument } from '../user/user.model'

/**
 * Một dòng danh bạ thành viên.
 *
 * Tên và ảnh KHÔNG snapshot vào `memberships` mà đọc từ `User` lúc trả: đây là danh bạ đang
 * SỐNG — người đổi tên xong mà roster vẫn hiện tên cũ thì quản lý gán nhầm nhóm, gán nhầm
 * quyền. Ngược hẳn với `Listing.posterName`, nơi snapshot mới đúng vì tin là bản ghi của một
 * thời điểm.
 *
 * Hai mức: thành viên thường thấy tên/ảnh/vai trò/nhóm con; quản trị thấy thêm bậc uy tín,
 * ngày vào và kênh gia nhập.
 *
 * `trustLevel` là bậc TOÀN CỤC của tài khoản (`UserTrust`), không phải bậc trong org này —
 * uy tín đã gộp làm một, xem `trust.model.ts`.
 *
 * Chỉ `name` + `avatar` của User: danh bạ để NHẬN RA người và gán quyền, không phải bản sao hồ
 * sơ — email/phone không có việc gì ở đây, cùng tinh thần với ranh giới của `PublicProfileDto`.
 */
export function toMemberDto(
  doc: IMembershipDocument,
  user: IUserDocument | undefined,
  /** `undefined` = người gọi là thành viên thường, không được thấy phần hồ sơ kiểm duyệt. */
  trustLevel: number | undefined,
) {
  const base = {
    userId: doc.userId.toString(),
    // Membership sống lâu hơn tài khoản: user xoá mềm rơi khỏi `find` nên chỗ này phải có chữ.
    name: user?.name ?? 'Tài khoản đã xoá',
    avatar: user?.avatar ?? '',
    role: doc.role,
    unitId: doc.unitId ? doc.unitId.toString() : null,
  }

  // Thành viên thường thấy nhau để biết mình đang ở cùng nhóm với ai — đủ để nhận ra người,
  // hết. Bậc uy tín, ngày vào và kênh gia nhập là hồ sơ vận hành của bàn quản trị.
  if (trustLevel === undefined) return base

  return {
    ...base,
    joinedVia: doc.joinedVia,
    trustLevel,
    joinedAt: doc.joinedAt.toISOString(),
  }
}
