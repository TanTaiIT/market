import { describe, it, expect } from 'vitest'
import {
  BUCKET_FORMAT,
  bucketLabel,
  bucketsBetween,
  resolveRange,
  startOfLabel,
} from '../../src/common/report/timeBuckets'
import { REPORT_GRANULARITY, REPORT_WINDOW } from '../../src/common/constants'

const at = (iso: string) => new Date(iso)

describe('Nhãn cột theo múi giờ thị trường', () => {
  /**
   * Ca quan trọng nhất của cả file: 20h UTC ngày 8 là 3h SÁNG NGÀY 9 ở Việt Nam.
   *
   * Gộp theo UTC (mặc định của `$dateToString`) sẽ đẩy toàn bộ tin đăng từ 0h–7h sáng giờ VN
   * về ngày hôm trước — mỗi ngày lệch một phần đáng kể, và biểu đồ vẫn "trông hợp lý" nên
   * không ai phát hiện.
   */
  it('mốc sau 17h UTC thuộc về NGÀY HÔM SAU của giờ Việt Nam', () => {
    expect(bucketLabel(at('2026-09-08T20:00:00Z'), REPORT_GRANULARITY.DAY)).toBe('2026-09-09')
    expect(bucketLabel(at('2026-09-08T16:59:00Z'), REPORT_GRANULARITY.DAY)).toBe('2026-09-08')
  })

  it('cuối tháng và cuối năm cũng nhảy theo giờ VN', () => {
    expect(bucketLabel(at('2026-08-31T20:00:00Z'), REPORT_GRANULARITY.MONTH)).toBe('2026-09')
    expect(bucketLabel(at('2026-12-31T20:00:00Z'), REPORT_GRANULARITY.YEAR)).toBe('2027')
  })

  it('định dạng của Mongo khớp với nhãn tính ở Node', () => {
    expect(BUCKET_FORMAT[REPORT_GRANULARITY.DAY]).toBe('%Y-%m-%d')
    expect(bucketLabel(at('2026-09-08T03:00:00Z'), REPORT_GRANULARITY.DAY)).toHaveLength(10)
    expect(bucketLabel(at('2026-09-08T03:00:00Z'), REPORT_GRANULARITY.MONTH)).toHaveLength(7)
    expect(bucketLabel(at('2026-09-08T03:00:00Z'), REPORT_GRANULARITY.YEAR)).toHaveLength(4)
  })
})

describe('Dãy cột không bỏ trống', () => {
  it('ngày: liên tiếp, không thiếu cột nào', () => {
    const labels = bucketsBetween(at('2026-09-01T02:00:00Z'), at('2026-09-05T02:00:00Z'), 'day')
    expect(labels).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'])
  })

  /** Đi từng ngày rồi lọc trùng — tránh hẳn lớp lỗi "31/01 cộng một tháng ra 03/03". */
  it('tháng: gộp trùng, và tháng cuối luôn có mặt', () => {
    const labels = bucketsBetween(at('2026-01-31T02:00:00Z'), at('2026-04-01T02:00:00Z'), 'month')
    expect(labels).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
  })

  it('năm: khoảng dài vẫn ra đúng số cột', () => {
    const labels = bucketsBetween(at('2023-06-01T02:00:00Z'), at('2026-02-01T02:00:00Z'), 'year')
    expect(labels).toEqual(['2023', '2024', '2025', '2026'])
  })

  it('from trùng to thì đúng một cột', () => {
    expect(bucketsBetween(at('2026-09-08T02:00:00Z'), at('2026-09-08T09:00:00Z'), 'day')).toEqual([
      '2026-09-08',
    ])
  })
})

describe('Chốt khoảng thời gian', () => {
  const now = at('2026-09-10T05:00:00Z')

  it('thiếu from/to thì lấy cửa sổ mặc định của độ mịn', () => {
    for (const g of ['day', 'month', 'year'] as const) {
      const range = resolveRange({ granularity: g }, now)
      const labels = bucketsBetween(range.from, range.to, g)
      expect(labels.length).toBe(REPORT_WINDOW[g].defaultBuckets)
      expect(range.truncated).toBe(0)
    }
  })

  /** Vượt trần thì giữ phần MỚI NHẤT và nói ra số cột đã cắt, không im lặng trả một nửa. */
  it('vượt trần thì cắt phần cũ và báo số cột bị cắt', () => {
    const range = resolveRange(
      { granularity: 'day', from: at('2020-01-01T00:00:00Z'), to: now },
      now,
    )
    const labels = bucketsBetween(range.from, range.to, 'day')

    expect(labels.length).toBe(REPORT_WINDOW.day.maxBuckets)
    expect(range.truncated).toBeGreaterThan(1000)
    // Giữ phần mới: cột cuối vẫn là hôm nay.
    expect(labels[labels.length - 1]).toBe(bucketLabel(now, 'day'))
  })

  it('khoảng đảo ngược trả về đúng một cột thay vì mảng rỗng', () => {
    const range = resolveRange(
      { granularity: 'day', from: at('2026-09-10T00:00:00Z'), to: at('2026-09-01T00:00:00Z') },
      now,
    )
    expect(bucketsBetween(range.from, range.to, 'day')).toHaveLength(1)
  })
})

describe('Mốc đầu cột', () => {
  /**
   * Nhãn `2026-03` ở UTC+7 bắt đầu lúc 17h ngày 28/02 UTC. Lấy nhầm nửa đêm UTC sẽ kéo thêm 7
   * tiếng của cột trước vào kết quả — đúng 7 tiếng đông người đăng nhất trong ngày.
   */
  it('đầu tháng tính theo giờ VN, không phải nửa đêm UTC', () => {
    expect(startOfLabel('2026-03', 'month').toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(startOfLabel('2026-09-08', 'day').toISOString()).toBe('2026-09-07T17:00:00.000Z')
    expect(startOfLabel('2026', 'year').toISOString()).toBe('2025-12-31T17:00:00.000Z')
  })
})
