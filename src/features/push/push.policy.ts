import { PUSH_CATEGORY, PUSH_CATEGORIES } from '../../common/constants'
import type { PushCategory } from '../../common/constants'

/**
 * Luật THUẦN của push — không đụng DB, không đụng mạng, để test unit phủ trọn mọi nhánh.
 * Thiết kế tổng: docs/architecture/push-notification.plan.md.
 */

export const PUSH_LIMITS = {
  /** Màn hình khoá cắt ở ~60 ký tự tiêu đề; dài hơn là người dùng chỉ thấy dấu "…" của hệ điều hành. */
  TITLE_MAX: 60,
  BODY_MAX: 150,
  /** Người đổi máy nhiều lần không để lại một đuôi thiết bị chết nhận push hộ. */
  DEVICES_MAX: 10,
  /** Tin chat dồn trong cửa sổ này gộp thành MỘT push "N tin nhắn mới". */
  CHAT_COALESCE_MS: 30_000,
  /** Trần của Expo: 100 tin / request gửi. */
  SEND_BATCH: 100,
  /** Expo nhận tới 1000 id / request receipt; 300 để request không phình quá lớn. */
  RECEIPT_BATCH: 300,
  /** Receipt thường có sau vài phút — hỏi sớm hơn là nhận về rỗng. */
  RECEIPT_DELAY_MS: 15 * 60 * 1000,
  /** Mỗi lượt claim bao nhiêu dòng outbox. */
  DISPATCH_BATCH: 200,
  /** Dòng `sending` quá lâu = process chết giữa chừng; lượt quét sau nhận lại. */
  CLAIM_STALE_MS: 5 * 60 * 1000,
  /** Fan-out cho cả nhóm ghi outbox theo lô cỡ này. */
  ENQUEUE_CHUNK: 500,
  /** Tổng số lần thử gửi một dòng (lần đầu + 3 lần retry theo `RETRY_DELAYS_MS`). */
  MAX_ATTEMPTS: 4,
  DEVICE_STALE_DAYS: 90,
  DEVICE_DISABLED_KEEP_DAYS: 30,
} as const

/** Lùi dần giữa các lần retry: 1 phút, 5 phút, 15 phút. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

interface CategoryConfig {
  priority: 'high' | 'default'
  /** Push trễ quá mốc này thì vô nghĩa — hộp thư đã giữ bản gốc. */
  ttlSeconds: number
  /** `false` = không tắt được, kể cả bằng công tắc tổng. */
  optional: boolean
  defaultOn: boolean
}

const HOUR = 3600
const DAY = 24 * HOUR

export const PUSH_CATEGORY_CONFIG: Record<PushCategory, CategoryConfig> = {
  [PUSH_CATEGORY.CHAT]: { priority: 'high', ttlSeconds: HOUR, optional: true, defaultOn: true },
  [PUSH_CATEGORY.LISTING_STATUS]: {
    priority: 'default',
    ttlSeconds: DAY,
    optional: true,
    defaultOn: true,
  },
  [PUSH_CATEGORY.MEMBERSHIP]: {
    priority: 'default',
    ttlSeconds: DAY,
    optional: true,
    defaultOn: true,
  },
  [PUSH_CATEGORY.REPORT]: { priority: 'default', ttlSeconds: DAY, optional: true, defaultOn: true },
  // Khoá tài khoản, quản chế: người dùng buộc phải biết — không có công tắc nào tắt được.
  [PUSH_CATEGORY.ACCOUNT]: { priority: 'high', ttlSeconds: DAY, optional: false, defaultOn: true },
  [PUSH_CATEGORY.WALLET]: { priority: 'default', ttlSeconds: DAY, optional: true, defaultOn: true },
  [PUSH_CATEGORY.GROUP_NOTICE]: {
    priority: 'default',
    ttlSeconds: DAY,
    optional: true,
    defaultOn: true,
  },
  // Nhóm 500 người là 500 push mỗi tin — mặc định TẮT, ai muốn theo dõi thì tự bật.
  [PUSH_CATEGORY.GROUP_ACTIVITY]: {
    priority: 'default',
    ttlSeconds: DAY,
    optional: true,
    defaultOn: false,
  },
  [PUSH_CATEGORY.SUPPORT]: { priority: 'high', ttlSeconds: DAY, optional: true, defaultOn: true },
}

export const OPTIONAL_PUSH_CATEGORIES = PUSH_CATEGORIES.filter(
  (c) => PUSH_CATEGORY_CONFIG[c].optional,
)
export const LOCKED_PUSH_CATEGORIES = PUSH_CATEGORIES.filter(
  (c) => !PUSH_CATEGORY_CONFIG[c].optional,
)

/** Dạng lưu trên `User.pushPrefs` — mọi field tuỳ chọn, thiếu = theo mặc định của nhóm. */
export interface StoredPushPrefs {
  enabled?: boolean | null
  categories?: Map<string, boolean> | Record<string, boolean> | null
}

export interface PushPrefs {
  enabled: boolean
  categories: Record<PushCategory, boolean>
}

/** Ghép lựa chọn đã lưu với mặc định. Nhận cả `Map` (document) lẫn object thuần (`.lean()`). */
export function resolvePushPrefs(stored: StoredPushPrefs | null | undefined): PushPrefs {
  const saved = stored?.categories
  const read = (c: PushCategory): boolean | undefined =>
    saved instanceof Map ? saved.get(c) : saved?.[c]
  const categories = {} as Record<PushCategory, boolean>
  for (const c of PUSH_CATEGORIES) {
    const cfg = PUSH_CATEGORY_CONFIG[c]
    categories[c] = cfg.optional ? (read(c) ?? cfg.defaultOn) : true
  }
  return { enabled: stored?.enabled ?? true, categories }
}

export function isPushAllowed(prefs: PushPrefs, category: PushCategory): boolean {
  if (!PUSH_CATEGORY_CONFIG[category].optional) return true
  return prefs.enabled && prefs.categories[category]
}

/** Nhóm tắt theo mặc định chỉ gửi cho người ĐÃ BẬT — lọc từ lúc enqueue để khỏi ghi dòng thừa. */
export function requiresOptIn(category: PushCategory): boolean {
  return !PUSH_CATEGORY_CONFIG[category].defaultOn
}

/** Cắt theo ký tự Unicode (không theo UTF-16 code unit) để không xẻ đôi emoji hay dấu tiếng Việt. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max - 1).join('') + '…'
}

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token)
}

/**
 * Chỉ nhận đường dẫn NỘI BỘ của app: bắt đầu bằng một `/`, không có scheme, không `//`. App cũng
 * chốt lại lần nữa trước khi điều hướng — đây là lớp đầu, để BE không bao giờ phát ra link lạ.
 */
export function isSafePushPath(path: string): boolean {
  return /^\/[A-Za-z0-9/_\-[\]()]*$/.test(path) && !path.startsWith('//') && path.length <= 200
}

/** Mốc lần thử kế tiếp, hoặc `null` khi đã hết lượt — `attempts` là số lần ĐÃ thử. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= PUSH_LIMITS.MAX_ATTEMPTS) return null
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]
  return new Date(now.getTime() + delay)
}

/** Đuôi của body khi gộp nhiều tin — repository ghép nó với số đếm ngay trong lượt ghi Mongo. */
export const CHAT_MANY_SUFFIX = ' tin nhắn mới'

/** Nội dung push chat: KHÔNG kèm nội dung tin — màn hình khoá là nơi người khác nhìn thấy được. */
export function chatPushText(senderName: string, count: number) {
  const who = truncate(senderName || 'Ai đó', 40)
  return {
    title: who,
    body: count > 1 ? `${count}${CHAT_MANY_SUFFIX}` : 'Đã gửi cho bạn một tin nhắn',
  }
}

export interface ExpoMessage {
  to: string
  title: string
  body: string
  data: Record<string, string>
  channelId: string
  priority: 'high' | 'default'
  ttl: number
  sound: 'default'
}

/** Dựng một tin Expo cho một thiết bị. Độ dài đã chốt ở đây nên payload luôn dưới trần 4096 byte. */
export function buildExpoMessage(
  row: {
    category: PushCategory
    title: string
    body: string
    data: { path?: string | null; notificationId?: string | null; conversationId?: string | null }
  },
  token: string,
): ExpoMessage {
  const cfg = PUSH_CATEGORY_CONFIG[row.category]
  const data: Record<string, string> = { category: row.category }
  if (row.data.path) data.path = row.data.path
  if (row.data.notificationId) data.notificationId = row.data.notificationId
  if (row.data.conversationId) data.conversationId = row.data.conversationId
  return {
    to: token,
    title: truncate(row.title, PUSH_LIMITS.TITLE_MAX),
    body: truncate(row.body, PUSH_LIMITS.BODY_MAX),
    data,
    // Kênh Android trùng tên nhóm: app tạo sẵn đủ kênh lúc khởi động (xem `push-setup.ts` phía app).
    channelId: row.category,
    priority: cfg.priority,
    ttl: cfg.ttlSeconds,
    sound: 'default',
  }
}

/** Lỗi Expo mà gửi lại có thể thành công; còn lại gửi lại chỉ là lặp cùng một thất bại. */
export function isRetryableExpoError(code: string | undefined): boolean {
  return (
    code === 'MessageRateExceeded' ||
    code === 'InvalidCredentials' ||
    code === 'MismatchSenderId' ||
    code === 'ProviderError' ||
    code === undefined
  )
}

/** Lỗi do CẤU HÌNH của mình (credential FCM/APNs) — phải có người xem ngay, không chỉ retry. */
export function isCredentialError(code: string | undefined): boolean {
  return code === 'InvalidCredentials' || code === 'MismatchSenderId'
}
