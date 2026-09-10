import {
  REPORT_GRANULARITY,
  REPORT_TIMEZONE,
  REPORT_WINDOW,
  ReportGranularity,
} from '../../common/constants'

/**
 * Phép tính lịch của báo cáo — hàm THUẦN, không chạm DB, không đọc `Date.now()` ngoài mặc định.
 *
 * Tách khỏi service vì đây là chỗ dễ sai nhất và cũng là chỗ dễ test nhất: mọi lỗi lệch múi
 * giờ, lệch một cột, hay thiếu cột rỗng đều nằm trong file này, và unit test bắt được chúng mà
 * không cần dựng Mongo.
 */

/** Định dạng khoá gộp của Mongo cho từng độ mịn — PHẢI khớp `bucketLabel` bên dưới. */
export const BUCKET_FORMAT: Record<ReportGranularity, string> = {
  [REPORT_GRANULARITY.DAY]: '%Y-%m-%d',
  [REPORT_GRANULARITY.MONTH]: '%Y-%m',
  [REPORT_GRANULARITY.YEAR]: '%Y',
}

/**
 * Nhãn cột của một mốc thời gian, tính THEO MÚI GIỜ THỊ TRƯỜNG.
 *
 * `en-CA` vì locale đó cho ra đúng `YYYY-MM-DD` — cùng dạng chuỗi mà `$dateToString` của Mongo
 * trả về, nên hai bên ghép được với nhau mà không cần lớp quy đổi thứ ba.
 */
export function bucketLabel(at: Date, granularity: ReportGranularity): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

  if (granularity === REPORT_GRANULARITY.YEAR) return parts.slice(0, 4)
  if (granularity === REPORT_GRANULARITY.MONTH) return parts.slice(0, 7)
  return parts
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Mọi nhãn cột từ `from` tới `to`, KHÔNG bỏ trống.
 *
 * Cột rỗng phải có mặt: một ngày không ai đăng tin là thông tin (sự cố? ngày lễ?), còn bỏ nó đi
 * thì biểu đồ nối thẳng hai ngày cách nhau một tuần thành một đoạn dốc và người đọc thấy một xu
 * hướng chưa từng xảy ra.
 *
 * Bước nhảy 24h an toàn vì `REPORT_TIMEZONE` là múi giờ CỐ ĐỊNH (UTC+7, Việt Nam không có giờ
 * mùa hè). Đổi sang một múi giờ có DST thì phải tính lại bằng `Intl`, không cộng mili-giây nữa.
 */
export function bucketsBetween(from: Date, to: Date, granularity: ReportGranularity): string[] {
  const labels: string[] = []
  const seen = new Set<string>()

  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const label = bucketLabel(new Date(t), granularity)
    if (!seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
  }

  // Đi từng NGÀY kể cả khi gộp theo tháng/năm rồi lọc trùng: rẻ (tối đa ~7300 vòng cho trần 20
  // năm) và tránh hẳn lớp lỗi "cộng một tháng" — 31/01 + 1 tháng ra 03/03 ở năm không nhuận.
  const lastOfTo = bucketLabel(to, granularity)
  if (!seen.has(lastOfTo)) labels.push(lastOfTo)

  return labels
}

export interface ReportRange {
  from: Date
  to: Date
  granularity: ReportGranularity
  /** Số cột bị cắt vì vượt trần — client hiện ra chứ không giấu. */
  truncated: number
}

/**
 * Chốt khoảng thời gian thật của một yêu cầu: điền mặc định, kẹp trần, và nói ra phần bị cắt.
 *
 * `now` nhận qua tham số để test kiểm được lịch mà không phải đóng băng đồng hồ toàn cục.
 */
export function resolveRange(
  input: { granularity: ReportGranularity; from?: Date; to?: Date },
  now: Date = new Date(),
): ReportRange {
  const { granularity } = input
  const { defaultBuckets, maxBuckets } = REPORT_WINDOW[granularity]

  const to = input.to ?? now
  // Mặc định lùi theo SỐ CỘT của chính độ mịn đó: `day` 30 ngày, `month` 12 tháng, `year` 5 năm
  // — quy về ngày để dùng chung một phép trừ, không cần lịch.
  const spanDays = { day: 1, month: 31, year: 366 }[granularity]
  const from = input.from ?? new Date(to.getTime() - (defaultBuckets - 1) * spanDays * DAY_MS)

  if (from > to) {
    // Người gọi đảo ngược khoảng — trả về đúng một cột thay vì mảng rỗng khó hiểu.
    return { from: to, to, granularity, truncated: 0 }
  }

  const labels = bucketsBetween(from, to, granularity)
  if (labels.length <= maxBuckets) return { from, to, granularity, truncated: 0 }

  /*
   * Vượt trần thì giữ phần MỚI NHẤT: báo cáo là công cụ nhìn hiện trạng, cắt mất tháng này để
   * giữ tháng của ba năm trước là ngược với lý do người ta mở nó.
   */
  const kept = labels.slice(-maxBuckets)
  const cutFrom = startOfLabel(kept[0]!, granularity)
  return { from: cutFrom, to, granularity, truncated: labels.length - maxBuckets }
}

/**
 * Mốc thời gian UTC ứng với đầu một nhãn cột, tính từ múi giờ thị trường.
 *
 * Dùng để dựng lại `from` sau khi cắt trần: nhãn `2026-03` ở UTC+7 bắt đầu lúc 17h ngày 28/02
 * theo UTC, và lấy nhầm nửa đêm UTC sẽ kéo thêm 7 tiếng của cột trước vào kết quả.
 */
export function startOfLabel(label: string, granularity: ReportGranularity): Date {
  const [y, m, d] = label.split('-')
  const iso = `${y}-${granularity === REPORT_GRANULARITY.YEAR ? '01' : m}-${
    granularity === REPORT_GRANULARITY.DAY ? d : '01'
  }T00:00:00`
  // Việt Nam cố định UTC+7 — xem ghi chú ở `bucketsBetween` về giả định này.
  return new Date(`${iso}+07:00`)
}
