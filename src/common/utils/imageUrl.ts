import { z } from 'zod'
import { env } from '../../config/env'

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
 * Chốt host luôn; chốt cả CLOUD NAME khi server biết nó (`CLOUDINARY_CLOUD_NAME`, audit 1.16) —
 * host là chung cho mọi tài khoản Cloudinary, ai cũng đăng ký được một cloud, nên chỉ chốt host là
 * nhận ảnh của cloud lạ với đủ ba rủi ro trên. Đổi tài khoản = đổi env, không phải sửa code.
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
      const url = new URL(value)
      if (url.host !== CLOUDINARY_HOST) return false
      const cloud = env.CLOUDINARY_CLOUD_NAME
      return !cloud || url.pathname.startsWith(`/${cloud}/`)
    } catch {
      return false
    }
  }, `Ảnh phải là đường dẫn Cloudinary (${CLOUDINARY_HOST}) của hệ thống`)
