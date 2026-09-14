import { Types } from 'mongoose'
import { ISocialFeedbackDocument } from './social-feedback.model'
import { socialFeedbackRepository } from './social-feedback.repository'
import { CreateSocialFeedbackInput, ReviewSocialFeedbackInput } from './social-feedback.schema'
import { SOCIAL_FEEDBACK_STATUS, SocialFeedbackStatus } from '../../common/constants'
import { NotFoundError } from '../../common/errors'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'
import { logger } from '../../config/logger'

/** Bản công khai — xem `socialFeedbackResponseSchema` về việc vì sao thiếu `status`. */
function toDto(row: ISocialFeedbackDocument) {
  return {
    id: row._id.toString(),
    orgName: row.orgName,
    decisionNo: row.decisionNo,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  }
}

function toAdminDto(row: ISocialFeedbackDocument) {
  return {
    ...toDto(row),
    status: row.status,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  }
}

async function page(status: SocialFeedbackStatus, query: { page?: number; limit?: number }) {
  const pagination = parsePagination(query)
  const { items, total } = await socialFeedbackRepository.paginate(status, pagination)
  return {
    items,
    meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
  }
}

export const socialFeedbackService = {
  /**
   * Tiếp nhận một ý kiến. Luôn vào `pending`, không có cờ nào bỏ qua bước đó.
   *
   * Trả về DTO công khai chứ không phải document: người gửi không cần biết trạng thái nội bộ,
   * và trả nguyên document là đường rò `status` ra cửa không đăng nhập.
   */
  async submit(input: CreateSocialFeedbackInput) {
    const row = await socialFeedbackRepository.create(input)
    logger.info('social feedback submitted', { id: row._id.toString(), orgName: row.orgName })
    return toDto(row)
  },

  /** Trang công bố — CHỈ bản đã duyệt. Đây là đường công khai, không đăng nhập. */
  async listPublished(query: { page?: number; limit?: number }) {
    const { items, meta } = await page(SOCIAL_FEEDBACK_STATUS.PUBLISHED, query)
    return { items: items.map(toDto), meta }
  },

  /** Hàng đợi của master. Mặc định là `pending` vì đó là thứ duy nhất cần người xử lý. */
  async listForReview(query: { page?: number; limit?: number; status?: SocialFeedbackStatus }) {
    const { items, meta } = await page(query.status ?? SOCIAL_FEEDBACK_STATUS.PENDING, query)
    return { items: items.map(toAdminDto), meta }
  },

  async review(id: string, input: ReviewSocialFeedbackInput, actorId: string) {
    const row = await socialFeedbackRepository.setStatus(
      id,
      input.status,
      new Types.ObjectId(actorId),
    )
    if (!row) throw new NotFoundError('Không tìm thấy ý kiến này')
    logger.info('social feedback reviewed', { id, status: input.status, actorId })
    return toAdminDto(row)
  },
}
