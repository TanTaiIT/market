import { socialFeedbackService } from './social-feedback.service'
import { queryOf } from '../../middlewares/validate.middleware'
import {
  socialFeedbackQuerySchema,
  socialFeedbackReviewQuerySchema,
} from './social-feedback.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const socialFeedbackController = {
  // POST /social-feedback
  submit: catchAsync(async (req, res) => {
    const row = await socialFeedbackService.submit(req.body)
    created(res, { message: 'Đã tiếp nhận ý kiến của bạn', data: row })
  }),

  // GET /social-feedback
  listPublished: catchAsync(async (req, res) => {
    const { items, meta } = await socialFeedbackService.listPublished(
      queryOf(req, socialFeedbackQuerySchema),
    )
    success(res, { message: 'Social feedback', data: items, meta })
  }),

  // GET /social-feedback/review
  listForReview: catchAsync(async (req, res) => {
    const { items, meta } = await socialFeedbackService.listForReview(
      queryOf(req, socialFeedbackReviewQuerySchema),
    )
    success(res, { message: 'Social feedback queue', data: items, meta })
  }),

  // PATCH /social-feedback/:id
  review: catchAsync(async (req, res) => {
    const row = await socialFeedbackService.review(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Social feedback reviewed', data: row })
  }),
}
