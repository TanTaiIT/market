import { socialFeedbackService } from './social-feedback.service'
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
    const { items, meta } = await socialFeedbackService.listPublished(req.query as never)
    success(res, { message: 'Social feedback', data: items, meta })
  }),

  // GET /social-feedback/review
  listForReview: catchAsync(async (req, res) => {
    const { items, meta } = await socialFeedbackService.listForReview(req.query as never)
    success(res, { message: 'Social feedback queue', data: items, meta })
  }),

  // PATCH /social-feedback/:id
  review: catchAsync(async (req, res) => {
    const row = await socialFeedbackService.review(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Social feedback reviewed', data: row })
  }),
}
