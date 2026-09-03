import { createHash, timingSafeEqual } from 'crypto'
import { z } from 'zod'

/**
 * Luật THUẦN cho webhook kiểm duyệt ảnh của Cloudinary — không chạm DB, không đọc env.
 *
 * Bối cảnh: FE upload ảnh bằng unsigned preset (xem `docs/VueSer/src/api/cloudinary.ts`), nên
 * tham số `moderation` không thể gửi từ client — nó được cấu hình NGAY TRÊN preset ở Cloudinary
 * Console (Add-ons: aws_rek / google_vision / webpurify...). Kết quả duyệt về sau qua webhook
 * `POST /webhooks/cloudinary` kèm chữ ký; module này giữ hai phép kiểm để đường đó tin được:
 * chữ ký có hợp lệ không, và ảnh bị từ chối là ảnh NÀO trong DB.
 */

/** Chỉ sự kiện loại này mới được xử lý — Cloudinary còn bắn upload/delete... nếu bật global. */
export const MODERATION_NOTIFICATION_TYPE = 'moderation'

/**
 * Payload Cloudinary gửi khi một lượt kiểm duyệt chốt kết quả. Khai tối thiểu và để `z.object`
 * mặc định BỎ QUA field lạ thay vì chặn: Cloudinary thêm field mới không được làm webhook câm.
 */
export const cloudinaryModerationEventSchema = z.object({
  notification_type: z.string(),
  moderation_status: z.enum(['approved', 'rejected', 'pending', 'aborted']).optional(),
  moderation_kind: z.string().optional(),
  public_id: z.string().min(1).optional(),
})

export type CloudinaryModerationEvent = z.infer<typeof cloudinaryModerationEventSchema>

/**
 * Kiểm chữ ký `X-Cld-Signature` = hash(rawBody + timestamp + api_secret).
 *
 * Nhận cả SHA-1 (mặc định của Cloudinary) lẫn SHA-256 (tài khoản bật
 * `signature_algorithm: sha256`) — thử lần lượt thay vì bắt cấu hình khớp tay đôi bên.
 * So bằng `timingSafeEqual` để độ lệch thời gian không rò ra vị trí ký tự sai.
 */
export function verifyCloudinarySignature(
  rawBody: string | Buffer,
  timestamp: string,
  signature: string,
  apiSecret: string,
): boolean {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody
  const payload = Buffer.concat([body, Buffer.from(timestamp + apiSecret)])

  return (['sha1', 'sha256'] as const).some((algo) => {
    const expected = createHash(algo).update(payload).digest('hex')
    const given = Buffer.from(signature)
    const want = Buffer.from(expected)
    return given.length === want.length && timingSafeEqual(given, want)
  })
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * RegExp khớp mọi URL đang LƯU TRONG DB trỏ tới asset này — cùng hình dạng với `publicIdOf`
 * của job dọn ảnh (`upload.cleanup.service.ts`): secure_url nguyên bản từ upload, có thể kèm
 * version `v123`, không có chuỗi transformation. Hai phía phải cùng một định nghĩa "URL của
 * public_id", lệch nhau là webhook gỡ hụt ảnh mà job dọn lại thấy.
 */
export function rejectedImagePattern(publicId: string, cloudName: string): RegExp {
  return new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegex(cloudName)}/image/upload/(?:v\\d+/)?${escapeRegex(publicId)}\\.[A-Za-z0-9]+$`,
  )
}

/** Một câu chữ duy nhất cho mọi chỗ nói về ảnh bị máy từ chối — thông báo và vết duyệt đọc y nhau. */
export const REJECTED_IMAGE_REASON =
  'Ảnh trong tin không đạt tiêu chuẩn nội dung (hệ thống kiểm duyệt ảnh từ chối)'
