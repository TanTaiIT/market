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
