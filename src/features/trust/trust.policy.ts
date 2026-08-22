/**
 * Luật thăng/giáng bậc uy tín — hàm THUẦN, không chạm DB.
 *
 * Trước đây luật này được viết hai lần: một bản trong `membershipRepository.adjustTrust` cho
 * trục org, một bản trong `trustRepository` cho trục danh mục. Cùng một câu "5 bài sạch lên
 * một bậc" mà hai đoạn code — sửa một chỗ quên chỗ kia là hai trục lệch nhau âm thầm. Giờ chỉ
 * còn đây, và nó test được mà không cần Mongo (xem `tests/unit/trustPolicy.test.ts`).
 */

/** Bao nhiêu bài sạch thì lên một bậc. */
export const CLEAN_APPROVALS_PER_LEVEL = 5

export interface TrustState {
  /** Bậc uy tín. `isAutoApprove` mở quyền tự đăng từ bậc 2. */
  level: number
  /** Số bài được duyệt sạch LIÊN TIẾP. Nguồn của bậc; một lần bị từ chối là mất sạch. */
  cleanApprovals: number
}

/** Đóng băng: đây là giá trị dùng chung, một lần ai đó lỡ tay sửa là sai ở mọi chỗ. */
export const ZERO_TRUST: TrustState = Object.freeze({ level: 0, cleanApprovals: 0 })

/**
 * Trạng thái sau một lượt duyệt.
 *
 * Bất đối xứng có chủ ý: lên bậc cần 5 bài sạch, xuống bậc chỉ cần MỘT lần bị từ chối. Uy tín
 * là thứ khó kiếm dễ mất — ngược lại thì một người đã có bậc cao sẽ bào mòn nó rất chậm trong
 * khi thiệt hại họ gây ra là tức thì.
 *
 * Từ chối KHÔNG xoá trắng bậc: tụt một bậc rồi phải làm lại 5 bài sạch cho bậc đó. Xoá trắng
 * biến một lần sai sót thành án tử, và người dùng sẽ bỏ tài khoản đi tạo cái mới — đúng thứ
 * hệ thống uy tín cần tránh nhất.
 */
export function nextTrust(current: TrustState, approved: boolean): TrustState {
  if (!approved) {
    return { level: Math.max(0, current.level - 1), cleanApprovals: 0 }
  }

  const cleanApprovals = current.cleanApprovals + 1
  // Thăng bậc TỪNG NẤC, không tính lại bậc từ độ dài chuỗi.
  //
  // Bản cũ dùng `level = floor(clean / 5)` ở cả hai trục, và nó sập ngay sau một lần bị từ
  // chối: bậc 3 chuỗi 15 → bị từ chối còn bậc 2 chuỗi 0 → duyệt sạch MỘT tin thành
  // `floor(1 / 5) = 0`. Một lần sai sót xoá sạch bậc — đúng thứ dòng trên nói là không được làm.
  const promoted = cleanApprovals % CLEAN_APPROVALS_PER_LEVEL === 0
  return { level: current.level + (promoted ? 1 : 0), cleanApprovals }
}
