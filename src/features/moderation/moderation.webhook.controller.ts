import { Request } from 'express'
import {
  cloudinaryModerationEventSchema,
  MODERATION_NOTIFICATION_TYPE,
  verifyCloudinarySignature,
} from './moderation.webhook'
import { imageModerationService } from './moderation.webhook.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'
import { NotImplementedError, UnauthorizedError } from '../../common/errors'
import { env } from '../../config/env'
import { logger } from '../../config/logger'

/** `app.ts` gắn rawBody trong `verify` của express.json — chữ ký ký trên BYTE, không phải object. */
type RawBodyRequest = Request & { rawBody?: Buffer }

export const moderationWebhookController = {
  // POST /webhooks/cloudinary — Cloudinary gọi, không phải client của mình.
  cloudinary: catchAsync(async (req, res) => {
    const { CLOUDINARY_API_SECRET, CLOUDINARY_CLOUD_NAME } = env
    if (!CLOUDINARY_API_SECRET || !CLOUDINARY_CLOUD_NAME) {
      // Cùng tinh thần với job dọn ảnh: thiếu CLOUDINARY_* nghĩa là tính năng đang tắt.
      throw new NotImplementedError(
        'Webhook kiểm duyệt ảnh đang tắt — thiếu CLOUDINARY_* trong env',
      )
    }

    // Chữ ký đứng TRƯỚC mọi phép đọc payload: endpoint này public, không có authenticate,
    // nên hash + secret là cánh cửa duy nhất giữa Internet và một lệnh gỡ ảnh diện rộng.
    const timestamp = req.get('x-cld-timestamp') ?? ''
    const signature = req.get('x-cld-signature') ?? ''
    const rawBody = (req as RawBodyRequest).rawBody
    if (
      !rawBody ||
      !timestamp ||
      !signature ||
      !verifyCloudinarySignature(rawBody, timestamp, signature, CLOUDINARY_API_SECRET)
    ) {
      throw new UnauthorizedError('Chữ ký webhook không hợp lệ')
    }

    /*
     * Từ đây trở xuống mọi nhánh "không xử lý" đều trả 200 chứ không 4xx: lỗi làm Cloudinary
     * RETRY, mà retry một payload mình cố tình bỏ qua thì lần sau vẫn bị bỏ qua — chỉ tổ đầy log
     * hai phía. 200 = "đã nhận, không có gì để làm".
     */
    const parsed = cloudinaryModerationEventSchema.safeParse(req.body)
    if (!parsed.success) {
      logger.warn('cloudinary webhook: payload không đọc được, bỏ qua', {
        issues: parsed.error.issues,
      })
      success(res, { message: 'Bỏ qua — payload không đọc được' })
      return
    }

    const event = parsed.data
    if (event.notification_type !== MODERATION_NOTIFICATION_TYPE || !event.public_id) {
      success(res, { message: 'Bỏ qua — không phải sự kiện kiểm duyệt' })
      return
    }
    if (event.moderation_status !== 'rejected') {
      // `approved` không cần làm gì: ảnh vốn đang được phục vụ bình thường trong lúc chờ.
      success(res, { message: `Đã nhận — trạng thái ${event.moderation_status ?? 'không rõ'}` })
      return
    }

    const data = await imageModerationService.applyRejection(event.public_id, CLOUDINARY_CLOUD_NAME)
    success(res, { message: 'Đã gỡ ảnh bị từ chối', data })
  }),
}
