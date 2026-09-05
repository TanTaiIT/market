import { describe, it, expect } from 'vitest'
import { AREA_HALF_LIFE_DAYS, inferProvince } from '../../src/features/user/user.area'
import type { VnProvinceName } from '../../src/common/constants'

const NOW = new Date('2026-09-05T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** Tin đăng cách đây `days` ngày, ở `province`. */
const at = (province: VnProvinceName, days: number) => ({
  province,
  postedAt: new Date(NOW.getTime() - days * DAY),
})

/** Nhiều tin cùng tỉnh, cùng tuổi — ca hay gặp nhất và cũng là ca dễ đọc nhất khi test đỏ. */
const many = (province: VnProvinceName, days: number, count: number) =>
  Array.from({ length: count }, () => at(province, days))

describe('inferProvince', () => {
  it('không có tin nào thì trả null — không đoán bừa một tỉnh mặc định', () => {
    expect(inferProvince([], NOW)).toBeNull()
  })

  it('tất cả tin ở một tỉnh thì trả tỉnh đó', () => {
    expect(inferProvince(many('Đà Nẵng', 12, 4), NOW)).toBe('Đà Nẵng')
  })

  /*
   * Hai ca dưới đây là LÝ DO tồn tại của phép cân theo tuổi. Mỗi luật đơn lẻ chỉ giải được một
   * ca và trả lời sai ca kia — nên chúng đứng cạnh nhau ở đây, đỏ một cái là biết vừa nghiêng
   * `AREA_HALF_LIFE_DAYS` quá tay về phía nào.
   */
  it('người đã CHUYỂN NHÀ: vài tin mới thắng nhiều tin cũ', () => {
    const samples = [...many('Hà Nội', 300, 20), ...many('Đà Nẵng', 15, 3)]
    expect(inferProvince(samples, NOW)).toBe('Đà Nẵng')
  })

  it('người ĐI CÔNG TÁC: một tin lạc lõng mới nhất không lật được cả khu vực', () => {
    const samples = [...many('Hồ Chí Minh', 30, 10), at('Hà Nội', 0)]
    expect(inferProvince(samples, NOW)).toBe('Hồ Chí Minh')
  })

  it('đếm thuần không đủ: 1 tin hôm nay thắng 1 tin của một năm trước', () => {
    expect(inferProvince([at('Huế', 365), at('Cần Thơ', 0)], NOW)).toBe('Cần Thơ')
  })

  it('đúng một chu kỳ bán rã thì hai tin cũ mới hoà được một tin mới', () => {
    // 2 × 0,5 = 1,0 so với 1 × 1,0 = 1,0 → hoà điểm, gỡ hoà bằng tin mới nhất.
    const samples = [...many('Nghệ An', AREA_HALF_LIFE_DAYS, 2), at('Gia Lai', 0)]
    expect(inferProvince(samples, NOW)).toBe('Gia Lai')
  })

  it('hoà điểm tuyệt đối thì lấy tỉnh có tin MỚI NHẤT, không phụ thuộc thứ tự đầu vào', () => {
    const older = at('Hải Phòng', 10)
    const newer = at('Quảng Ninh', 3)
    expect(inferProvince([older, newer], NOW)).toBe('Quảng Ninh')
    // Đảo thứ tự phải ra cùng kết quả — nếu không thì kết quả đang do thứ tự `Map` quyết định.
    expect(inferProvince([newer, older], NOW)).toBe('Quảng Ninh')
  })

  it('tin có mốc thời gian ở TƯƠNG LAI không được nặng hơn một tin thường', () => {
    // Lệch giờ máy chủ hoặc dữ liệu seed đẩy `postedAt` vượt `now`; không kẹp tuổi tại 0 thì
    // trọng số vọt lên > 1 và một tin duy nhất đè bẹp cả chục tin thật.
    const samples = [...many('Hồ Chí Minh', 0, 2), at('Lào Cai', -3650)]
    expect(inferProvince(samples, NOW)).toBe('Hồ Chí Minh')
  })
})
