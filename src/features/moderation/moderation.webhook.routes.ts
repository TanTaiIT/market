import { Router } from 'express'
import { moderationWebhookController } from './moderation.webhook.controller'

/*
 * Webhook máy-gọi-máy, tách khỏi `moderation.routes.ts` vì khác hẳn hai điều:
 * - KHÔNG `authenticate`/`validate` — người gọi là Cloudinary, xác thực bằng chữ ký
 *   `X-Cld-Signature` (kiểm trong controller, cần raw body mà validate middleware không giữ).
 * - KHÔNG đăng ký OpenAPI — spec là nguồn sinh SDK cho FE, một endpoint FE không bao giờ
 *   được gọi mà chui vào SDK chỉ tạo cám dỗ dùng sai.
 *
 * URL đầy đủ (khai ở Cloudinary Console, mục Notification URL của upload preset):
 *   https://<host>/api/v1/webhooks/cloudinary
 */
const router = Router()

router.post('/cloudinary', moderationWebhookController.cloudinary)

export default router
