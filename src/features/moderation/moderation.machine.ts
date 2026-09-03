/**
 * Người duyệt MÁY — luật thuần cho job quét hàng đợi `pending`, không chạm DB.
 *
 * Vị trí trong hệ: đứng SAU fast-path tự đăng (uy tín bậc 2 lên bảng ngay trong request, xem
 * `listing.quota.ts`), đứng TRƯỚC người duyệt thật. Máy chỉ được ba quyền:
 * - `approve` — mọi phép kiểm đều sạch → tin lên bảng, người duyệt khỏi phải nhìn;
 * - `reject`  — DUY NHẤT khi dính cụm từ cấm, vì đó là phép kiểm ít oan sai nhất;
 * - `hold`    — mọi nghi ngờ còn lại: để nguyên trong hàng đợi cho người thật, kèm lý do.
 *
 * Máy duyệt KHÔNG cộng uy tín (quyết định thiết kế): `cleanApprovals` phải nghĩa là "người
 * thật đã nhìn". Nếu máy cũng cộng, farm bậc 2 chỉ cần đăng tin nhạt vào khung giờ vắng người
 * duyệt — rồi dùng bậc đó tự đăng tin bẩn. Đối xứng lại, máy từ chối cũng KHÔNG trừ bậc: oan
 * sai của máy không được phép phá bậc người ta cày bằng tin thật. Cái giá của lượt từ chối máy
 * nằm ở `countRecentRejections` — nó tự khoá cửa tự-đăng và bóp quota 7 ngày, đủ đau.
 */

export const MACHINE_REVIEW = {
  /** Mỗi lượt quét xử tối đa chừng này tin; phần dư chờ lượt sau. */
  BATCH_SIZE: 50,
  /** Trên mức này máy không dám tự duyệt — tiền lớn phải có mắt người. */
  MAX_AUTO_PRICE: 50_000_000,
  /** Cỡ mẫu tính giá phổ biến của danh mục. */
  PRICE_SAMPLE_SIZE: 50,
  /** Dưới chừng này tin mẫu thì median vô nghĩa — bỏ phép kiểm giá tương đối. */
  PRICE_MIN_SAMPLE: 5,
  /** Lệch quá N lần median (cả hai phía) là bất thường. */
  PRICE_OUTLIER_RATIO: 10,
  /** Cửa sổ soi tin trùng của cùng người bán. */
  DUPLICATE_WINDOW_DAYS: 7,
} as const

/**
 * Cụm cấm KHỞI ĐIỂM — chỉ để seed (`scripts/seed-banned-phrases.ts`) và test. Runtime đọc từ
 * DB qua `bannedPhraseService.phrases()` (master quản qua /banned-phrases), KHÔNG đọc mảng
 * này: sửa ở đây không đổi được gì trên hệ đang chạy.
 *
 * Chỉ nhận CỤM ít nhập nhằng — từ đơn như "súng" sẽ chém oan "súng phun nước đồ chơi".
 */
export const DEFAULT_BANNED_PHRASES = [
  'ma túy',
  'ma tuý',
  'cần sa',
  'heroin',
  'thuốc lắc',
  'tiền giả',
  'bằng cấp giả',
  'bằng giả',
  'giấy tờ giả',
  'pháo nổ',
  'thuốc nổ',
  'súng đạn',
  'vũ khí quân dụng',
  'ngà voi',
  'sừng tê giác',
  'mật gấu',
  'vảy tê tê',
] as const

export const MACHINE_HOLDS = [
  'price_over_cap',
  'price_outlier',
  'duplicate_title',
  'recent_rejection',
  'category_manual_review',
  // Không đến từ lượt quét mà từ webhook Cloudinary (moderation.webhook.service.ts): một ảnh
  // của tin PENDING bị máy kiểm ảnh từ chối — ảnh đã bị rút, phần chữ chờ người thật xem nốt.
  'image_rejected',
] as const
export type MachineHold = (typeof MACHINE_HOLDS)[number]

/** Giá trị lưu trong `Listing.machineReview.verdict`. */
export const MACHINE_VERDICTS = ['approved', 'rejected', 'held'] as const
export type MachineVerdictKind = (typeof MACHINE_VERDICTS)[number]

export interface MachineSignals {
  title: string
  description: string
  /** Từ điển cụm cấm tại thời điểm chấm — caller lấy từ `bannedPhraseService.phrases()`. */
  bannedPhrases: readonly string[]
  price: number
  /** Median giá tin ACTIVE cùng danh mục; `null` = chưa đủ mẫu, bỏ phép kiểm tương đối. */
  categoryMedianPrice: number | null
  hasRecentRejection: boolean
  hasDuplicateTitle: boolean
  categoryRequiresReview: boolean
}

export type MachineVerdict =
  | { verdict: 'approve' }
  | { verdict: 'reject'; reason: string }
  | { verdict: 'hold'; holds: MachineHold[] }

/** Cụm cấm đầu tiên xuất hiện trong đoạn text, hoặc `null` nếu sạch. */
export function bannedPhraseIn(text: string, phrases: readonly string[]): string | null {
  const haystack = text.toLowerCase()
  return phrases.find((phrase) => haystack.includes(phrase)) ?? null
}

/** Một câu chữ duy nhất cho lượt từ chối vì hàng cấm — cổng lúc đăng và máy quét nói y nhau. */
export function bannedContentReason(phrase: string): string {
  return `Tin chứa nội dung bị cấm: "${phrase}"`
}

export function reviewByMachine(signals: MachineSignals): MachineVerdict {
  // Từ chối xét trước và độc quyền: tin chứa hàng cấm thì các nghi ngờ khác không còn nghĩa.
  const banned = bannedPhraseIn(`${signals.title}\n${signals.description}`, signals.bannedPhrases)
  if (banned) {
    return { verdict: 'reject', reason: bannedContentReason(banned) }
  }

  const holds: MachineHold[] = []
  if (signals.categoryRequiresReview) holds.push('category_manual_review')
  if (signals.hasRecentRejection) holds.push('recent_rejection')
  if (signals.hasDuplicateTitle) holds.push('duplicate_title')
  if (signals.price > MACHINE_REVIEW.MAX_AUTO_PRICE) holds.push('price_over_cap')
  if (isPriceOutlier(signals.price, signals.categoryMedianPrice)) holds.push('price_outlier')

  return holds.length > 0 ? { verdict: 'hold', holds } : { verdict: 'approve' }
}

/** Median của mẫu giá, hoặc `null` khi mẫu quá mỏng để nói lên điều gì. */
export function medianOf(prices: number[]): number | null {
  if (prices.length < MACHINE_REVIEW.PRICE_MIN_SAMPLE) return null
  const sorted = [...prices].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function isPriceOutlier(price: number, median: number | null): boolean {
  if (median === null || median <= 0) return false
  return (
    price > median * MACHINE_REVIEW.PRICE_OUTLIER_RATIO ||
    price * MACHINE_REVIEW.PRICE_OUTLIER_RATIO < median
  )
}
