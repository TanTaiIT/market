/**
 * Quota tin chờ duyệt — hàm THUẦN, không chạm DB.
 *
 * Đây là backpressure đúng nghĩa: người dùng chỉ tạo thêm việc cho người duyệt khi việc cũ đã
 * được xử lý. Nhưng nó **giới hạn khối lượng, không giới hạn phạm vi** — một tin bôi nhọ vào
 * hàng đợi đã là sự cố, không cần tới tin thứ năm. Vì vậy phải có thêm hai thứ ở đây:
 *
 * 1. `recentRejections` — đếm tin bị từ chối XUYÊN TRỤC trong 7 ngày. Đây là thứ bịt lỗ hổng
 *    "duyệt/từ chối xong lại có slot trống, đăng tiếp vô hạn" (§8.4).
 * 2. Người ngoài có bucket riêng, hạn mức cứng, không theo uy tín.
 */

/** Hạn mức tin chờ duyệt theo bậc uy tín. Chỉ số = `trustLevel`, vượt bảng thì lấy bậc cuối. */
export const TRUST_PENDING_LIMITS = [3, 5, 10] as const

export const QUOTA = {
  /** Người ngoài org: cứng, không theo uy tín — họ chưa có quan hệ nào với tổ chức đó. */
  OUTSIDER_LIMIT: 2,
  /** Có tin bị từ chối trong cửa sổ → hạ về 1 tin chờ, buộc phải xử lý xong mới đăng tiếp. */
  PENALIZED_LIMIT: 1,
  /** Đủ số lần bị từ chối trong cửa sổ → khoá quyền đăng, cần người gỡ tay. */
  REJECTION_BLOCK: 3,
  REJECTION_WINDOW_DAYS: 7,
  /** Từ bậc này trở lên: tin tự đăng, chỉ hậu kiểm. */
  AUTO_APPROVE_TRUST_LEVEL: 2,
} as const

export type QuotaReason = 'blocked_by_rejections' | 'quota_full'

export interface QuotaInput {
  trustLevel: number
  isOutsider: boolean
  /** Số tin bị từ chối trong `REJECTION_WINDOW_DAYS` ngày, ĐẾM CẢ HAI TRỤC. */
  recentRejections: number
  /** Số tin đang chờ duyệt trong đúng bucket đang xét. */
  pendingCount: number
}

export interface QuotaVerdict {
  allowed: boolean
  limit: number
  pending: number
  remaining: number
  reason?: QuotaReason
}

export function pendingLimitFor(
  input: Pick<QuotaInput, 'trustLevel' | 'isOutsider' | 'recentRejections'>,
): number {
  if (input.isOutsider) return QUOTA.OUTSIDER_LIMIT
  if (input.recentRejections > 0) return QUOTA.PENALIZED_LIMIT

  const level = Math.min(Math.max(input.trustLevel, 0), TRUST_PENDING_LIMITS.length - 1)
  return TRUST_PENDING_LIMITS[level]
}

/** Uy tín KHÔNG chuyển giữa các trục — caller phải truyền bậc của đúng trục đang xét (§8.3). */
export function isAutoApprove(trustLevel: number, recentRejections: number): boolean {
  if (recentRejections > 0) return false
  return trustLevel >= QUOTA.AUTO_APPROVE_TRUST_LEVEL
}

export function checkQuota(input: QuotaInput): QuotaVerdict {
  const limit = pendingLimitFor(input)

  if (input.recentRejections >= QUOTA.REJECTION_BLOCK) {
    return {
      allowed: false,
      limit,
      pending: input.pendingCount,
      remaining: 0,
      reason: 'blocked_by_rejections',
    }
  }

  const remaining = Math.max(0, limit - input.pendingCount)
  return {
    allowed: remaining > 0,
    limit,
    pending: input.pendingCount,
    remaining,
    ...(remaining > 0 ? {} : { reason: 'quota_full' as const }),
  }
}
