import { VN_PROVINCE_NAMES, VnProvinceName } from '../../common/constants'

/**
 * Suy KHU VỰC của một người từ nơi họ đã đăng tin.
 *
 * Tồn tại vì `location.province` trên hồ sơ là tuỳ chọn và phần lớn người dùng không bao giờ
 * điền — mà không có nó thì mọi thứ "quanh bạn" đều tắt. Người đã đăng tin thì đã tự khai chỗ
 * mình ở rồi, chỉ là khai gián tiếp: mỗi tin mang một `location.province` do chính họ chọn.
 *
 * Thuần, không đụng DB: nhận mẫu vào, trả tên tỉnh ra. Luật chọn dưới đây là phần dễ sai và
 * khó thấy sai nhất của tính năng, nên nó phải test được mà không cần dựng cả một database.
 */

/**
 * Tin đã đăng, rút gọn còn đúng hai thứ luật chọn cần biết.
 *
 * `province` là tên tỉnh HIỆN HÀNH, không phải chuỗi bất kỳ — người gọi lọc bằng
 * `isProvinceName` trước khi vào đây, nên kết quả trả ra cũng là một tên hợp lệ và không
 * call-site nào phải ép kiểu.
 */
export interface ProvinceSample {
  province: VnProvinceName
  postedAt: Date
}

/**
 * Chuỗi này còn là một trong 34 tỉnh HIỆN HÀNH không.
 *
 * Cần thiết vì `location.province` trong DB là dữ liệu lịch sử: tin đăng trước lần sáp nhập
 * 01/07/2025 còn mang tên tỉnh đã bị nhập. Suy ra một tỉnh không còn tồn tại thì không nhóm
 * nào khớp được, và khối "quanh bạn" hiện ra rỗng thay vì ẩn đi — trạng thái khó hiểu hơn hẳn.
 */
export function isProvinceName(value: string | undefined | null): value is VnProvinceName {
  return typeof value === 'string' && (VN_PROVINCE_NAMES as readonly string[]).includes(value)
}

/**
 * Sau ngần này ngày, một tin chỉ còn đáng một NỬA so với tin đăng hôm nay.
 *
 * 90 ngày là mốc cân được hai ca đối nghịch — cả hai đều có thật, và mỗi luật đơn lẻ chỉ giải
 * được một:
 *
 * - **Người đã chuyển nhà.** 20 tin cũ ở Hà Nội (300 ngày) so với 3 tin mới ở Đà Nẵng (15
 *   ngày): Hà Nội được 20 × 0.5^3,33 ≈ 1,99 còn Đà Nẵng được 3 × 0.5^0,17 ≈ 2,67 → Đà Nẵng
 *   thắng. Đếm số lượng thuần sẽ trả về nơi họ đã rời đi cả năm trước.
 * - **Người đi công tác.** 10 tin ở TP.HCM rải trong 60 ngày so với 1 tin đăng ở Hà Nội hôm
 *   nay: TP.HCM ≈ 7,94 còn Hà Nội = 1 → TP.HCM thắng. Lấy "tin mới nhất" sẽ hất cả khu vực
 *   của một người sang nơi họ ghé qua ba ngày.
 *
 * Rút ngắn mốc này là nghiêng về ca thứ nhất, kéo dài là nghiêng về ca thứ hai.
 */
export const AREA_HALF_LIFE_DAYS = 90

/**
 * Chỉ xét ngần này tin gần nhất.
 *
 * Không phải để giới hạn độ chính xác mà để chặn trần công việc: với chu kỳ bán rã 90 ngày,
 * tin thứ 101 của một người đăng nhiều đã cũ tới mức trọng số của nó không đổi được thứ hạng.
 * Người bán chuyên nghiệp có 2.000 tin thì đây là khác biệt giữa một truy vấn và một cơn đau.
 */
export const AREA_SAMPLE_LIMIT = 100

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Tỉnh đại diện cho một người, hoặc `null` khi không đủ căn cứ.
 *
 * Điểm của mỗi tỉnh = tổng trọng số các tin ở đó, trọng số giảm theo tuổi tin
 * (`0,5 ^ (tuổi / AREA_HALF_LIFE_DAYS)`). Vừa đếm vừa cân tuổi, chứ không chọn một trong hai —
 * xem `AREA_HALF_LIFE_DAYS` cho hai ca mà mỗi luật đơn lẻ đều trả lời sai.
 *
 * Hoà điểm thì lấy tỉnh có TIN MỚI NHẤT. Cần một luật gỡ hoà tường minh vì không có nó thì kết
 * quả phụ thuộc thứ tự `Map` trả ra — chạy hai lần cùng dữ liệu có thể ra hai tỉnh khác nhau,
 * và không ai lần ra được vì sao.
 *
 * @param samples Tin đã đăng. Tin không có `province` phải được lọc TRƯỚC khi vào đây.
 * @param now Mốc tính tuổi — tham số chứ không phải `Date.now()`, để test cố định được thời gian.
 */
export function inferProvince(samples: ProvinceSample[], now: Date): VnProvinceName | null {
  const score = new Map<VnProvinceName, number>()
  const latest = new Map<VnProvinceName, number>()

  for (const sample of samples) {
    // Tin có `postedAt` ở TƯƠNG LAI (lệch giờ máy chủ, dữ liệu seed) sẽ nhận trọng số > 1 và
    // đè bẹp mọi tin thật. Kẹp tuổi tại 0: mới nhất cũng chỉ đáng đúng một tin.
    const ageDays = Math.max(0, (now.getTime() - sample.postedAt.getTime()) / DAY_MS)
    const weight = 0.5 ** (ageDays / AREA_HALF_LIFE_DAYS)

    score.set(sample.province, (score.get(sample.province) ?? 0) + weight)
    latest.set(
      sample.province,
      Math.max(latest.get(sample.province) ?? 0, sample.postedAt.getTime()),
    )
  }

  let best: VnProvinceName | null = null
  for (const [province, points] of score) {
    if (best === null) {
      best = province
      continue
    }
    const bestPoints = score.get(best)!
    if (points > bestPoints) best = province
    else if (points === bestPoints && latest.get(province)! > latest.get(best)!) best = province
  }
  return best
}
