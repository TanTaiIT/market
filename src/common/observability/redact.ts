/**
 * Che dữ liệu nhạy cảm TRƯỚC khi một dòng log rời process (audit 7.8, logging-monitoring §2).
 *
 * Ở tầng format của logger chứ không ở từng call-site: ~200 lời gọi `logger.*` rải khắp
 * service, và chỗ quên che sẽ là chỗ log `email` thật hay mã đặt lại mật khẩu — đúng thứ mà
 * hệ thu log tập trung (và mọi người có quyền đọc nó) không được thấy.
 */

export const MASK = '[redacted]'

/** Khoá mà GIÁ TRỊ bị thay hẳn — so không phân biệt hoa/thường. */
const SECRET_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'resettoken',
  'idtoken',
  'code',
  'otp',
  'authorization',
  'secret',
  'signature',
  'cookie',
])

/** Trần độ sâu khi duyệt object lồng — log không bao giờ cần sâu hơn, và nó chặn vòng tham chiếu. */
const MAX_DEPTH = 6

/** `tai.nguyen@example.com` → `t***@example.com`: đủ để nhận ra là ai khi điều tra, không đủ để gửi thư. */
export function maskEmail(value: string): string {
  const at = value.indexOf('@')
  if (at <= 0) return MASK
  return `${value[0]}***${value.slice(at)}`
}

/** Giữ 3 số cuối — cùng mức mà màn hồ sơ hiện cho người lạ. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return MASK
  return `***${digits.slice(-3)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Che theo TÊN KHOÁ, đệ quy vào object/array thuần. `Error` giữ nguyên (message/stack là thứ
 * cần đọc), `Date`/ObjectId/Buffer giữ nguyên (không phải plain object nên không duyệt vào).
 */
export function redactValue(key: string, value: unknown, depth = 0): unknown {
  const k = key.toLowerCase()
  if (SECRET_KEYS.has(k)) return value === undefined || value === null ? value : MASK
  if (k === 'email' && typeof value === 'string') return maskEmail(value)
  if (k === 'phone' && typeof value === 'string') return maskPhone(value)
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, depth + 1))
  if (isPlainObject(value)) return redactMeta(value, depth + 1)
  return value
}

export function redactMeta<T extends Record<string, unknown>>(meta: T, depth = 0): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) out[key] = redactValue(key, value, depth)
  return out as T
}

/**
 * Che GIÁ TRỊ của tham số nhạy cảm trên query string, giữ nguyên phần còn lại của URL để dòng
 * access log vẫn đọc được. `?code=123456` trong link xác thực email / đặt lại mật khẩu là ca thật.
 */
export function sanitizeUrl(url: string): string {
  const q = url.indexOf('?')
  if (q < 0) return url
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const key = eq < 0 ? pair : pair.slice(0, eq)
      if (!SECRET_KEYS.has(decodeURIComponent(key).toLowerCase())) return pair
      return `${key}=${MASK}`
    })
    .join('&')
  return `${url.slice(0, q)}?${query}`
}
