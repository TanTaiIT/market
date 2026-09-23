import { z } from 'zod'

/**
 * Trọn bộ thứ app cần để dựng một request upload có ký — không thiếu mảnh nào, và app không phải
 * tự biết mảnh nào cả.
 *
 * `cloudName`, `folder` và `uploadPreset` nằm ở đây thay vì hardcode bên app là có chủ ý: cả ba
 * đều là tham số ĐƯỢC KÝ (trừ `cloudName`, thứ đi vào URL), nên app tự chọn một giá trị khác là
 * chữ ký lệch và Cloudinary trả 401. Một nguồn sự thật, ở phía ký.
 */
export const uploadSignatureResponseSchema = z
  .object({
    cloudName: z.string(),
    apiKey: z.string(),
    /** Giây Unix. Gửi nguyên vẹn con số này lên Cloudinary, đừng tự sinh lại. */
    timestamp: z.number().int(),
    signature: z.string(),
    folder: z.string(),
    uploadPreset: z.string(),
  })
  .openapi('UploadSignature')
