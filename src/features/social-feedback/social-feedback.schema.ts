import { z } from 'zod'
import { PAGINATION, SOCIAL_FEEDBACK_STATUS } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const socialFeedbackParamsSchema = z.object({ id: objectId })

export const createSocialFeedbackSchema = z
  .object({
    orgName: z
      .string()
      .trim()
      .min(2, 'Tên tổ chức phải từ 2 ký tự')
      .max(200)
      .openapi({ example: 'Hội Bảo vệ người tiêu dùng tỉnh Bình Thuận' }),
    decisionNo: z
      .string()
      .trim()
      .min(1, 'Nhập số quyết định thành lập')
      .max(100)
      .openapi({ example: '1234/QĐ-UBND' }),
    /**
     * min 10: cửa này KHÔNG đăng nhập, nên một ô chấp nhận "ok" là một ô ai cũng bơm được.
     * Không phải chốt chống spam — chốt thật là rate limit ở tầng route cộng bước duyệt.
     */
    content: z
      .string()
      .trim()
      .min(10, 'Nội dung cần rõ hơn để chúng tôi xử lý')
      .max(5000)
      .openapi({ example: 'Đề nghị sàn bổ sung đầu mối tiếp nhận khiếu nại tại trang chủ.' }),
  })
  .strict()
  .openapi('CreateSocialFeedback')

export type CreateSocialFeedbackInput = z.infer<typeof createSocialFeedbackSchema>

export const socialFeedbackQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).optional(),
})

/** Bàn duyệt xem được cả ba trạng thái; bỏ trống = hàng đợi `pending`. */
export const socialFeedbackReviewQuerySchema = socialFeedbackQuerySchema.extend({
  status: z.nativeEnum(SOCIAL_FEEDBACK_STATUS).optional(),
})

export const reviewSocialFeedbackSchema = z
  .object({
    /** Chỉ hai đích đến; `pending` không nằm ở đây vì "trả về hàng đợi" không phải một quyết định. */
    status: z.enum([SOCIAL_FEEDBACK_STATUS.PUBLISHED, SOCIAL_FEEDBACK_STATUS.REJECTED]),
  })
  .strict()
  .openapi('ReviewSocialFeedback')

export type ReviewSocialFeedbackInput = z.infer<typeof reviewSocialFeedbackSchema>

/**
 * Bản CÔNG KHAI — cố ý thiếu `status`, `reviewedBy`, `reviewedAt`.
 *
 * Trang công bố chỉ trả bản đã duyệt, nên `status` ở đó luôn là một hằng số; còn ai duyệt là
 * việc nội bộ. Trả thừa ba field này là cách rò rỉ quy trình duyệt mà không ai cố ý.
 */
export const socialFeedbackResponseSchema = z
  .object({
    id: objectId,
    orgName: z.string(),
    decisionNo: z.string(),
    content: z.string(),
    createdAt: z.string(),
  })
  .openapi('SocialFeedback')

/** Bản của bàn duyệt — thêm đúng những gì người duyệt cần thấy. */
export const socialFeedbackAdminResponseSchema = socialFeedbackResponseSchema
  .extend({
    status: z.nativeEnum(SOCIAL_FEEDBACK_STATUS),
    reviewedAt: z.string().nullable(),
  })
  .openapi('SocialFeedbackAdmin')
