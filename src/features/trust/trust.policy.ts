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

/**
 * Trần bậc uy tín. PHẢI bằng ngưỡng tự đăng (`QUOTA.AUTO_APPROVE_TRUST_LEVEL`) — có canary test
 * neo hai con số này với nhau.
 *
 * Không chặn trần thì bậc tích vô hạn, và nó biến thành LỚP ĐỆM CHỐNG TRỪNG PHẠT: người có 30
 * bài sạch (bậc 6) bị từ chối chỉ tụt còn bậc 5 — vẫn trên ngưỡng, nên sau 7 ngày là tự đăng
 * lại như chưa có gì. Người mới đúng bậc 2 thì tụt còn 1, phải làm lại 5 bài sạch qua tay người
 * duyệt. Cùng một vi phạm, cái giá lệch nhau hàng tuần, và lệch theo hướng SAI: càng đăng nhiều
 * càng miễn nhiễm.
 *
 * Chặn trần khiến mọi người bán đứng cách hình phạt đúng một khoảng như nhau. Bậc trên trần
 * cũng chẳng mua thêm gì (hạn mức lấy `min(level, 2)`), nên không ai mất gì cả.
 */
export const MAX_TRUST_LEVEL = 2

export interface TrustState {
  /** Bậc uy tín. `isAutoApprove` mở quyền tự đăng từ bậc 2. */
  level: number
  /** Số bài được duyệt sạch LIÊN TIẾP. Nguồn của bậc; một lần bị từ chối là mất sạch. */
  cleanApprovals: number
}

/**
 * Trạng thái của người CHƯA có bản ghi uy tín nào — tức là mọi tài khoản vừa tạo.
 *
 * Bắt đầu ở TRẦN, không phải ở 0: sàn tin trước, thu lại khi vi phạm. Đây là quyết định sản
 * phẩm, không phải mặc định kỹ thuật — nó đảo chiều nghĩa của bậc uy tín:
 *
 * - Trước: bậc là thứ KIẾM được. Bậc 0 = "chưa ai biết bạn là ai", tin phải qua người duyệt,
 *   và người bán thật phải đăng 10 tin qua tay người duyệt trước khi được tự đăng.
 * - Giờ: bậc là thứ MẤT đi. Bậc trần = mặc định; tụt bậc nghĩa là "người này đã vi phạm".
 *
 * Hệ quả phải nhìn thẳng: hàng rào lúc đăng không còn là uy tín nữa mà là CỔNG NỘI DUNG —
 * cụm từ cấm và `fastPathFlagged` (tin trùng tiêu đề, giá vượt trần, giá lệch dị thường).
 * Đó là toàn bộ thứ đứng giữa một tài khoản vừa đăng ký và bảng tin công khai.
 *
 * `cleanApprovals: 0` chứ không phải 10: chuỗi sạch là thứ để LEO LẠI sau khi bị tụt, người
 * chưa từng bị tụt thì không cần tới nó. Đặt 10 ở đây chỉ tạo ra một con số giả trong hồ sơ.
 */
export const INITIAL_TRUST: TrustState = Object.freeze({
  level: MAX_TRUST_LEVEL,
  cleanApprovals: 0,
})

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
  return {
    // Chặn trần: xem `MAX_TRUST_LEVEL` cho lý do. `cleanApprovals` vẫn tăng tiếp vì nó là
    // chuỗi-sạch-liên-tiếp có nghĩa riêng, chỉ có bậc là dừng lại.
    level: Math.min(current.level + (promoted ? 1 : 0), MAX_TRUST_LEVEL),
    cleanApprovals,
  }
}
