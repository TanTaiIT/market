import { slugify } from './slugify'

/**
 * Tên org tách thành TỪ đã chuẩn hoá — khoá tra của ô tìm nhóm và bảng tổ chức.
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
  return [...new Set(slugify(name).split('-').filter(Boolean))]
}
