import { z } from 'zod'

const CLOUDINARY_HOST = 'res.cloudinary.com'

/**
 * CDN ảnh của Google. Hậu tố, không phải host đủ: `picture` trong ID token rơi vào `lh3`,
 * nhưng Google đã dùng `lh4`/`lh5`/`lh6` ở các thời kỳ khác nhau — chốt đúng một subdomain là
 * ngày họ đổi thì người đăng nhập bằng Google không lưu nổi hồ sơ nữa.
 */
const GOOGLE_AVATAR_SUFFIX = '.googleusercontent.com'

/** Host của một URL, `null` khi chuỗi không phải URL hợp lệ. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

/**
 * URL ảnh do client gửi lên — chỉ nhận ảnh nằm trên Cloudinary của chính hệ thống.
 *
 * `z.string().url()` không đủ, và ba lý do dưới đây đều là chuyện đã xảy ra ở các sàn khác:
 *
 * 1. **Đổi ruột sau khi duyệt.** Ảnh host ở nơi người bán kiểm soát thì họ thay file bất cứ lúc
 *    nào — tin qua đủ bốn lớp duyệt xong vẫn hiện ra thứ khác hẳn. URL Cloudinary mang version
 *    nên nội dung sau nó bất biến.
 * 2. **Pixel theo dõi.** Mỗi lượt xem tin là một request về máy chủ của họ, thu IP và thời điểm
 *    của người mua.
 * 3. **Ảnh chết theo host lạ.** Bảng tin phụ thuộc vào một domain mình không kiểm soát.
 *
 * Chỉ chốt HOST, không chốt cloud name: đổi tài khoản Cloudinary không phải là lý do sửa code.
 *
 * Dùng cho ảnh TIN ĐĂNG và avatar/cover NHÓM — tức mọi ảnh đi lên bảng tin. Avatar của một tài
 * khoản đi qua `userAvatarUrl` ngay dưới, vì nó có thêm một nguồn hợp lệ mà ba lý do trên không
 * áp vào.
 */
export const cloudinaryImageUrl = z
  .string()
  .url()
  .refine(
    (value) => hostOf(value) === CLOUDINARY_HOST,
    `Ảnh phải là đường dẫn Cloudinary (${CLOUDINARY_HOST})`,
  )

/**
 * URL avatar của một TÀI KHOẢN: Cloudinary của hệ thống, hoặc CDN ảnh của Google.
 *
 * Vì sao không dùng thẳng `cloudinaryImageUrl`: đăng nhập bằng Google ghi `identity.picture` vào
 * `avatar` ngay lúc tạo tài khoản (`auth.service`), và đó là URL của Google. Siết avatar về
 * riêng Cloudinary thì chính những người đó **không lưu nổi hồ sơ** — form gửi lại đúng cái
 * avatar hệ thống vừa gán cho họ và cả lượt lưu ăn 400. Lỗi sẽ hiện ra ở một chỗ chẳng liên
 * quan gì tới ảnh (đổi tên, đổi khu vực), nên rất khó lần.
 *
 * Vì sao nới cho Google là an toàn, trong khi nới cho một host bất kỳ thì không — soi lại đúng
 * ba lý do ở `cloudinaryImageUrl`: người gửi URL **không kiểm soát** nội dung trên CDN của
 * Google nên không đổi ruột được; request ảnh về máy chủ của Google chứ không về máy chủ của
 * họ, nên **không thu được IP** của ai; và đó không phải một domain tạm bợ. Cả ba lý do đều
 * nhắm vào host do NGƯỜI GỬI kiểm soát, mà Google thì không phải.
 *
 * Trước thay đổi này avatar chỉ qua `z.string().url()`, tức nhận MỌI host — pixel theo dõi gắn
 * vào avatar là chuyện làm được, và nó hiện ở mọi chỗ có mặt người dùng đó.
 */
export const userAvatarUrl = z
  .string()
  .url()
  .refine((value) => {
    const host = hostOf(value)
    if (host === null) return false
    // `endsWith` trên hậu tố CÓ DẤU CHẤM: `evil-googleusercontent.com` không lọt, còn
    // `lh3.googleusercontent.com` thì được.
    return host === CLOUDINARY_HOST || host.endsWith(GOOGLE_AVATAR_SUFFIX)
  }, `Avatar phải là đường dẫn Cloudinary (${CLOUDINARY_HOST}) hoặc ảnh Google`)
