import { z } from 'zod'

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
 * Đây là bản DÙNG CHUNG cho mọi ảnh nhận từ client (ảnh tin, avatar/cover nhóm) — trước đây
 * mỗi chỗ một luật là mỗi chỗ một mức chặt, và ảnh tin đã lỏng hơn ảnh nhóm suốt một thời gian.
 */
const CLOUDINARY_HOST = 'res.cloudinary.com'

export const cloudinaryImageUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).host === CLOUDINARY_HOST
    } catch {
      return false
    }
  }, `Ảnh phải là đường dẫn Cloudinary (${CLOUDINARY_HOST})`)
