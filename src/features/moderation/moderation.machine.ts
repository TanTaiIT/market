/**
 * Người duyệt MÁY — luật thuần cho job quét hàng đợi `pending`, không chạm DB.
 *
 * Vị trí trong hệ: đứng SAU fast-path tự đăng (uy tín bậc 2 lên bảng ngay trong request, xem
 * `listing.quota.ts`), đứng TRƯỚC người duyệt thật. Máy chỉ được ba quyền:
 * - `approve` — mọi phép kiểm đều sạch → tin lên bảng, người duyệt khỏi phải nhìn;
 * - `reject`  — DUY NHẤT khi dính cụm từ cấm, vì đó là phép kiểm ít oan sai nhất;
 * - `hold`    — mọi nghi ngờ còn lại: để nguyên trong hàng đợi cho người thật, kèm lý do.
 *
 * Máy NHÌN bậc uy tín (đổi 2026-09-26, audit 1.3): dưới `MIN_TRUST_LEVEL` là giữ cho người thật,
 * vì bậc thấp nghĩa là "đã vi phạm" (mặc định là trần, xem `INITIAL_TRUST`) — để máy duyệt hộ thì
 * hình phạt chỉ còn là vài phút chờ. Từ bậc 1 máy duyệt được, và lượt duyệt đó CÓ cộng
 * `cleanApprovals`: người tụt một bậc leo lại được bằng tin sạch mà không phải chờ người duyệt
 * rảnh. Cái giá đã cân: farm bậc bằng tin nhạt vẫn đội trần tin đang sống (`TRUST_LIVE_LIMITS`),
 * vẫn qua mọi phép kiểm của máy, và một lần vi phạm là mất bậc. Bậc 0 thì KHÔNG có đường máy —
 * năm tin đầu leo lại phải là người thật nhìn.
 *
 * Máy từ chối vẫn KHÔNG trừ bậc: oan sai của máy không được phép phá bậc người ta cày bằng tin
 * thật. Cái giá của lượt từ chối máy nằm ở `countRecentRejections` — nó tự khoá cửa tự-đăng và
 * bóp quota 7 ngày, đủ đau.
 */

import { looksMashed } from './gibberish'

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
  /** Dưới bậc này máy không duyệt hộ — xem đầu file. */
  MIN_TRUST_LEVEL: 1,
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
  /**
   * Tiêu đề/mô tả trông như gõ bừa ("gggggghhljflkajsdlf") — xem `gibberish.ts`.
   *
   * Là HOLD chứ không phải reject, và cố ý: heuristic thì có ngày đoán sai, mà cái giá của
   * lần sai đó phải là một cái liếc mắt của người duyệt chứ không phải một tin thật bị đánh
   * trượt. Nó cũng tự động tước fast-path lúc đăng, vì `fastPathFlagged` gọi cùng hàm này.
   */
  'gibberish',
  'price_over_cap',
  'price_outlier',
  'duplicate_title',
  'recent_rejection',
  'category_manual_review',
  /** Bậc dưới `MIN_TRUST_LEVEL` — người đã vi phạm phải qua người thật. */
  'trust_too_low',
  /** Án quản chế của master (`UserTrust.probation`). */
  'probation',
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
  /** Bậc uy tín của người đăng lúc chấm — caller lấy từ `trustRepository.standingOf`. */
  trustLevel: number
  onProbation: boolean
  /** Địa chỉ + thuộc tính chữ — chỉ cho cổng cụm cấm, KHÔNG đưa vào phép đo gõ bừa. */
  extraText?: string
}

export type MachineVerdict =
  | { verdict: 'approve' }
  | { verdict: 'reject'; reason: string }
  | { verdict: 'hold'; holds: MachineHold[] }

/**
 * Chuẩn hoá để SO KHỚP cụm cấm (audit 1.17): bỏ dấu, hạ chữ thường, gộp khoảng trắng. "MA TUY",
 * "ma  túy" và "ma tuý" phải cùng bắt được — người lách luật bỏ dấu trước tiên.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Mọi ô chữ tự do của một tin, ghép cho cổng cụm cấm (audit 1.17): tiêu đề, mô tả, địa chỉ và
 * giá trị chữ của thuộc tính — cụm cấm nhét vào "ghi chú thêm" của thuộc tính từng lọt.
 */
export function screenText(parts: {
  title: string
  description: string
  address?: string | null
  attributes?: Record<string, unknown> | Map<string, unknown> | null
}): string {
  const values =
    parts.attributes instanceof Map
      ? [...parts.attributes.values()]
      : Object.values(parts.attributes ?? {})
  return [
    parts.title,
    parts.description,
    parts.address ?? '',
    ...values.filter((v): v is string => typeof v === 'string'),
  ].join('\n')
}

/** Cụm cấm đầu tiên xuất hiện trong đoạn text (so sau khi chuẩn hoá cả hai bên), hoặc `null`. */
export function bannedPhraseIn(text: string, phrases: readonly string[]): string | null {
  const haystack = normalizeForMatch(text)
  return phrases.find((phrase) => haystack.includes(normalizeForMatch(phrase))) ?? null
}

/** Một câu chữ duy nhất cho lượt từ chối vì hàng cấm — cổng lúc đăng và máy quét nói y nhau. */
export function bannedContentReason(phrase: string): string {
  return `Tin chứa nội dung bị cấm: "${phrase}"`
}

export function reviewByMachine(signals: MachineSignals): MachineVerdict {
  // Từ chối xét trước và độc quyền: tin chứa hàng cấm thì các nghi ngờ khác không còn nghĩa.
  const banned = bannedPhraseIn(
    `${signals.title}\n${signals.description}\n${signals.extraText ?? ''}`,
    signals.bannedPhrases,
  )
  if (banned) {
    return { verdict: 'reject', reason: bannedContentReason(banned) }
  }

  const holds: MachineHold[] = []
  // Soi CẢ tiêu đề lẫn mô tả trong một chuỗi: người gõ bừa hiếm khi chỉ bừa một ô, và dấu
  // xuống dòng giữ cho token cuối tiêu đề không dính vào token đầu mô tả.
  if (
    looksMashed(`${signals.title}
${signals.description}`)
  )
    holds.push('gibberish')
  if (signals.categoryRequiresReview) holds.push('category_manual_review')
  if (signals.onProbation) holds.push('probation')
  if (signals.trustLevel < MACHINE_REVIEW.MIN_TRUST_LEVEL) holds.push('trust_too_low')
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
