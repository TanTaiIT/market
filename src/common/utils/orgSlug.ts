import { slugify } from './slugify'

/**
 * Slug của org là địa chỉ công khai (`/o/<slug>`, link mời, có thể là subdomain sau này) nên
 * nó vừa là khoá định tuyến vừa là bề mặt mạo danh. Ba lớp xử lý ở đây:
 *
 * 1. `normalizeOrgSlug` — khoá so trùng, bỏ cả dấu gạch để `ly--thuong-kiet`, `lythuongkiet`
 *    và `ly-thuong-kiet` rơi vào cùng một chỗ.
 * 2. Fold ký tự nhìn giống Latin (Cyrillic/Hy Lạp) TRƯỚC khi slugify — `slugify` chỉ xoá ký
 *    tự lạ, nên "аdmin" viết bằng а Cyrillic sẽ thành "dmin" thay vì bị chặn.
 * 3. `RESERVED_SLUGS` — chặn những slug làm vỡ routing hoặc mạo danh trang hệ thống.
 */

/** Ký tự nhìn giống Latin trong bảng mã khác. Không phải danh sách đủ, là danh sách hay bị dùng. */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  в: 'b',
  с: 'c',
  е: 'e',
  н: 'h',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  о: 'o',
  р: 'p',
  ѕ: 's',
  т: 't',
  и: 'u',
  х: 'x',
  у: 'y',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  ν: 'v',
  χ: 'x',
}

/**
 * Slug hệ thống giữ chỗ. Thiếu `o` là vỡ chính `/o/<slug>`; thiếu `admin`/`login`/`settings`
 * là mở đường cho một org tự đặt tên thành trang đăng nhập của hệ thống.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'assets',
  'billing',
  'blog',
  'dashboard',
  'docs',
  'help',
  'login',
  'logout',
  'me',
  'new',
  'o',
  'org',
  'organization',
  'platform',
  'public',
  'register',
  'search',
  'settings',
  'signup',
  'static',
  'support',
  'system',
  'user',
  'users',
  'www',
])

function foldConfusables(input: string): string {
  return Array.from(input)
    .map((ch) => CONFUSABLES[ch.toLowerCase()] ?? ch)
    .join('')
}

/** Slug hiển thị/định tuyến: vẫn giữ dấu gạch cho người đọc. */
export function toOrgSlug(input: string): string {
  return slugify(foldConfusables(input))
}

/**
 * Khoá so trùng — KHÔNG dùng để hiển thị. Bỏ hết dấu gạch nên `thpt-ly-thuong-kiet` và
 * `thptlythuongkiet` là một: hai org khác nhau lấy hai slug đó là chuyện mạo danh, không
 * phải chuyện trùng tên.
 */
export function normalizeOrgSlug(input: string): string {
  return toOrgSlug(input).replace(/-/g, '')
}

export function isReservedSlug(input: string): boolean {
  return RESERVED_SLUGS.has(normalizeOrgSlug(input))
}

/**
 * Tên org tách thành TỪ đã chuẩn hoá — khoá tra của dropdown chọn org.
 *
 * Vì sao là mảng từ chứ không phải một chuỗi `nameNormalized`: người ta gõ "hung" để tìm
 * "Trường Hùng Vương", mà tiền tố của cả chuỗi ("truonghungvuong") không khớp gì. Tách từ cho
 * mỗi từ một tiền tố tra được, tức mỗi điều kiện có BOUNDS thật trên index multikey — thứ mà
 * một regex không neo đầu (`{ $regex: 'hung', $options: 'i' }`) không bao giờ có, và đó là lý
 * do bản cũ quét trọn collection cho mỗi ký tự người dùng gõ.
 *
 * Đánh đổi: khớp theo đầu TỪ, không còn khớp giữa từ — "ương" không ra "Vương" nữa. Người dùng
 * gõ tiền tố chứ hiếm khi gõ khúc giữa, nên đây là đánh đổi có lời.
 */
export function orgNameTokens(name: string): string[] {
  return [...new Set(toOrgSlug(name).split('-').filter(Boolean))]
}

/**
 * Gợi ý hậu tố khi slug đã có người lấy. Ưu tiên hậu tố CÓ NGHĨA (quận/huyện, tỉnh) trước khi
 * rơi về đánh số: `thcs-ly-thuong-kiet-dong-da` phân biệt được bằng mắt, còn
 * `thcs-ly-thuong-kiet-2` thì người dùng chọn nhầm hệt như cũ (§6.3).
 */
export function suggestOrgSlugs(
  base: string,
  hints: { district?: string | null; provinceCode?: string | null } = {},
): string[] {
  const root = toOrgSlug(base)
  const suffixes = [hints.district, hints.provinceCode]
    .filter((value): value is string => Boolean(value))
    .map((value) => toOrgSlug(value))
    .filter(Boolean)

  const numbered = [2, 3].map((n) => `${root}-${n}`)
  return [...new Set([...suffixes.map((suffix) => `${root}-${suffix}`), ...numbered])]
}
