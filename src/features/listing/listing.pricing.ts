/**
 * Luật phí đăng tin — hàm THUẦN, không chạm DB. Nền móng cho hệ Xu (xem
 * `docs/rules/xu-wallet.decision.md`), đổ TRƯỚC khi cần để ngày bật phí không phải đập
 * lại luồng đăng tin.
 *
 * Giai đoạn hiện tại: MIỄN PHÍ có chủ đích (thu hút người dùng). Giá trị của file này
 * chưa nằm ở con số — nó nằm ở chỗ hợp đồng API đã mang field `fee` từ hôm nay: FE hiển
 * thị "Miễn phí" ngay bây giờ, ngày bật phí chỉ là con số đổi chứ không phải API mới
 * khiến app cũ trên máy khách gãy.
 *
 * Khi bật phí thật: `POST_FEE` chuyển từ hằng số sang config master sửa được, và
 * `postingFee` là chỗ DUY NHẤT cài luật giá (theo danh mục, giảm theo bậc uy tín…) —
 * hai tham số của nó đã chờ sẵn cho đúng việc đó.
 */

export const PRICING = {
  /** Phí một lượt đăng tin, đơn vị Xu. `0` = giai đoạn miễn phí. */
  POST_FEE: 0,
  /** Đơn vị tiền trong response — client không bao giờ phải đoán con số này là gì. */
  CURRENCY: 'xu',
} as const

export interface PostingFee {
  amount: number
  currency: typeof PRICING.CURRENCY
}

interface PostingFeeInput {
  /** Bậc uy tín người đăng — chỗ chờ sẵn cho chính sách "uy tín cao giảm phí". */
  trustLevel: number
  /** Danh mục đích — chỗ chờ sẵn cho chính sách giá theo danh mục. */
  categoryId?: string
}

export function postingFee(_input: PostingFeeInput): PostingFee {
  return { amount: PRICING.POST_FEE, currency: PRICING.CURRENCY }
}

// ── GÓI TIN ─────────────────────────────────────────────────────────────────

export const PRODUCT_EFFECTS = ['rank_to_top', 'featured', 'extend_expiry'] as const
export type ProductEffect = (typeof PRODUCT_EFFECTS)[number]

export interface ListingProductDef {
  code: string
  name: string
  effect: ProductEffect
  /** Số ngày hiệu lực — `null` với hiệu ứng tức thời (đẩy tin). */
  durationDays: number | null
  /** Giờ chờ giữa hai lượt mua trên CÙNG một tin — chống nhà giàu chiếm bảng. */
  cooldownHours: number | null
  /** `null` = chưa chốt giá — chốt bằng số liệu posting-stats, không đoán. */
  price: PostingFee | null
  /** Bật khi ví Xu vận hành — đường mua nằm ở giai đoạn sau (xu-wallet.decision.md §6). */
  enabled: boolean
}

/**
 * Catalog gói tin — SoT duy nhất, cùng nhà với phí đăng. Định nghĩa TRƯỚC khi bán được để
 * hợp đồng API (`GET /listings/products`) và UI của FE dựng xong chờ sẵn; ngày mở bán là
 * lật `enabled` + điền giá, không phải thiết kế mới.
 */
export const LISTING_PRODUCTS: readonly ListingProductDef[] = [
  {
    code: 'bump',
    name: 'Đẩy tin',
    effect: 'rank_to_top',
    durationDays: null,
    cooldownHours: 24,
    price: null,
    enabled: false,
  },
  {
    code: 'featured_3d',
    name: 'Tin nổi bật 3 ngày',
    effect: 'featured',
    durationDays: 3,
    cooldownHours: null,
    price: null,
    enabled: false,
  },
  {
    code: 'featured_7d',
    name: 'Tin nổi bật 7 ngày',
    effect: 'featured',
    durationDays: 7,
    cooldownHours: null,
    price: null,
    enabled: false,
  },
  {
    code: 'extend_30d',
    name: 'Gia hạn tin 30 ngày',
    effect: 'extend_expiry',
    durationDays: 30,
    cooldownHours: null,
    price: null,
    enabled: false,
  },
]
