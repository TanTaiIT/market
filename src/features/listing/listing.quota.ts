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

/**
 * Vì sao một tin được tự đăng, hoặc bị giữ lại chờ người duyệt.
 *
 * Không có thứ này thì khi một tin xấu lọt lên bảng, không ai trả lời được "lúc đó người đăng
 * bậc mấy" — bậc uy tín đã đổi từ lâu rồi. Điều tra sự cố thành đoán mò, và mọi lần chỉnh
 * ngưỡng sau này cũng không có dữ liệu nào để đối chiếu.
 */
export const AUTO_APPROVAL_REASONS = [
  'approved',
  'outsider_post',
  'recent_rejection',
  'category_manual_review',
  'trust_too_low',
  // Hai lý do của CỔNG NỘI DUNG — lớp chạy trước uy tín (moderation.machine.ts):
  // banned = tin thành REJECTED ngay từ cửa; flagged = đủ bậc nhưng bị tước fast-path.
  'content_banned',
  'content_flagged',
] as const

export type AutoApprovalReason = (typeof AUTO_APPROVAL_REASONS)[number]

/**
 * Suy ra lý do từ KẾT QUẢ thật (`autoApproved`) chứ không tính lại quyết định: tính lại là
 * dựng bản sao thứ hai của luật, và bản sao sẽ lệch với `routeListing` vào đúng ngày ai đó
 * sửa một chỗ. Chỉ khi tin BỊ GIỮ mới cần dò xem chốt nào chặn, theo đúng thứ tự chặn thật.
 */
export function autoApprovalReason(input: {
  autoApproved: boolean
  trustLevel: number
  recentRejections: number
  categoryRequiresReview: boolean
  isOutsider: boolean
  contentFlagged?: boolean
}): AutoApprovalReason {
  if (input.autoApproved) return 'approved'
  // Người ngoài không bao giờ tự đăng, bất kể uy tín — `routeListing` ép PENDING_UNVERIFIED.
  if (input.isOutsider) return 'outsider_post'
  if (input.recentRejections > 0) return 'recent_rejection'
  if (input.categoryRequiresReview) return 'category_manual_review'
  // Đứng SAU các chốt uy tín: flag chỉ được tính khi mọi chốt khác đã cho qua —
  // đúng thứ tự thật trong `create` (FLAG checks chỉ chạy khi fast-path sắp mở).
  if (input.contentFlagged) return 'content_flagged'
  return 'trust_too_low'
}

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

/** Một bậc uy tín dùng chung cho mọi luồng đăng — xem `trust.model.ts`. */
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

/** Phần của một tin mà người duyệt thực sự nhìn khi xét nó. */
export interface ReviewedContent {
  title: string
  description: string
  price: number
  images: string[]
  categoryId: string
}

/**
 * Bản sửa có chạm vào phần đã được duyệt không.
 *
 * So GIÁ TRỊ chứ không xem client có gửi field lên hay không: form sửa thường PATCH cả cụm và
 * gửi lại nguyên `title` cũ — đếm đó là thay đổi thì mỗi lần bật `isNegotiable` cũng đá tin
 * xuống hàng đợi duyệt.
 */
export function touchesReviewedContent(
  before: ReviewedContent,
  patch: Partial<ReviewedContent>,
): boolean {
  return (
    changed(patch.title, before.title) ||
    changed(patch.description, before.description) ||
    changed(patch.price, before.price) ||
    changed(patch.categoryId, before.categoryId) ||
    // Thứ tự tính: ảnh đầu tiên là ảnh đại diện, đảo chỗ là đổi thứ người mua nhìn thấy.
    (patch.images !== undefined && !sameImages(patch.images, before.images))
  )
}

/** `undefined` = client không gửi field đó lên, khác hẳn với gửi lên một giá trị mới. */
const changed = <T>(next: T | undefined, current: T) => next !== undefined && next !== current

const sameImages = (a: string[], b: string[]) =>
  a.length === b.length && a.every((url, i) => url === b[i])
