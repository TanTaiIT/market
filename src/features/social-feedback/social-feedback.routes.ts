import { z } from 'zod'
import { Router } from 'express'
import { socialFeedbackController } from './social-feedback.controller'
import {
  createSocialFeedbackSchema,
  reviewSocialFeedbackSchema,
  socialFeedbackAdminResponseSchema,
  socialFeedbackParamsSchema,
  socialFeedbackQuerySchema,
  socialFeedbackResponseSchema,
  socialFeedbackReviewQuerySchema,
} from './social-feedback.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { createRateLimiter } from '../../middlewares/rateLimiter.middleware'
import {
  registry,
  bearerAuth,
  envelope,
  errorResponse,
  jsonResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

/**
 * 5 lượt / 10 phút / IP — chặt hơn `authLimiter` (10/phút) vì đây là cửa GHI duy nhất trong
 * app mở cho người KHÔNG đăng nhập, nên nó là bề mặt spam rộng nhất hiện có.
 *
 * Con số chọn theo nghiệp vụ, không theo cảm tính: một tổ chức xã hội gửi kiến nghị vài lần
 * mỗi năm. Ai chạm trần 5 lượt trong 10 phút thì không phải đang làm việc đó.
 */
const submitLimiter = createRateLimiter({
  keyPrefix: 'rl:social-feedback',
  points: 5,
  duration: 600,
})

// ── CÔNG KHAI — không đăng nhập, cả đọc lẫn ghi ─────────────────────────────

/*
 * Cả hai đường dưới đây cố tình KHÔNG có `authenticate`, và đó là điểm của cụm này: nghĩa vụ
 * công bố là công bố cho người ngoài, kể cả người chưa từng có tài khoản. Bọc `optionalAuth`
 * cũng không: xem `ISocialFeedback.reviewedBy` về lý do không ghi danh tính người gửi.
 */
router.post(
  '/',
  submitLimiter,
  validate({ body: createSocialFeedbackSchema }),
  socialFeedbackController.submit,
)
router.get(
  '/',
  validate({ query: socialFeedbackQuerySchema }),
  socialFeedbackController.listPublished,
)

// ── BÀN DUYỆT — master-only ─────────────────────────────────────────────────

/*
 * `requireMaster` chứ không `requireAnyModerator`: ý kiến gửi về pháp nhân vận hành sàn, và
 * việc công bố nó là phát ngôn của công ty. Người phụ trách một nhóm hay một danh mục không
 * có thẩm quyền đó — trao cho họ là để một quản trị nhóm đăng chữ lên trang pháp lý chung.
 */
router.get(
  '/review',
  authenticate,
  requireMaster,
  validate({ query: socialFeedbackReviewQuerySchema }),
  socialFeedbackController.listForReview,
)
router.patch(
  '/:id',
  authenticate,
  requireMaster,
  validate({ params: socialFeedbackParamsSchema, body: reviewSocialFeedbackSchema }),
  socialFeedbackController.review,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'post',
  path: '/social-feedback',
  operationId: 'socialFeedbackSubmit',
  tags: ['SocialFeedback'],
  summary: 'Gửi đánh giá, phản ánh, kiến nghị của tổ chức xã hội (công khai)',
  description:
    'Cửa tiếp nhận ý kiến của tổ chức xã hội tham gia bảo vệ quyền lợi người tiêu dùng. ' +
    'Không cần đăng nhập, giới hạn 5 lượt / 10 phút / IP. Ý kiến vào trạng thái chờ duyệt và ' +
    'CHƯA hiện ở danh sách công bố cho tới khi master duyệt.',
  request: { body: { content: { 'application/json': { schema: createSocialFeedbackSchema } } } },
  responses: {
    201: jsonResponse('Đã tiếp nhận', envelope(socialFeedbackResponseSchema)),
    400: errorResponse('Dữ liệu không hợp lệ'),
    429: errorResponse('Gửi quá nhiều lần, thử lại sau'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/social-feedback',
  operationId: 'socialFeedbackList',
  tags: ['SocialFeedback'],
  summary: 'Danh sách đánh giá đã công bố (công khai)',
  description:
    'CHỈ trả bản đã duyệt, và không kèm `status` — trang này là bản công bố, không phải hàng ' +
    'đợi. Không cần đăng nhập.',
  request: { query: socialFeedbackQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách đã công bố',
      envelope(z.array(socialFeedbackResponseSchema), paginationMetaSchema),
    ),
  },
})

registry.registerPath({
  method: 'get',
  path: '/social-feedback/review',
  operationId: 'socialFeedbackReviewQueue',
  tags: ['SocialFeedback'],
  summary: 'Hàng đợi duyệt ý kiến (master)',
  description: 'Bỏ trống `status` = hàng đợi chờ duyệt. Kèm `status` để xem bản đã xử lý.',
  ...protectedRoute,
  request: { query: socialFeedbackReviewQuerySchema },
  responses: {
    200: jsonResponse(
      'Hàng đợi',
      envelope(z.array(socialFeedbackAdminResponseSchema), paginationMetaSchema),
    ),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/social-feedback/{id}',
  operationId: 'socialFeedbackReview',
  tags: ['SocialFeedback'],
  summary: 'Duyệt hoặc từ chối một ý kiến (master)',
  description:
    '`published` đưa ý kiến lên trang công bố; `rejected` giữ lại bản ghi nhưng không công bố. ' +
    'Không có đường xoá: đã tiếp nhận thì phải còn vết.',
  ...protectedRoute,
  request: {
    params: socialFeedbackParamsSchema,
    body: { content: { 'application/json': { schema: reviewSocialFeedbackSchema } } },
  },
  responses: {
    200: jsonResponse('Đã xử lý', envelope(socialFeedbackAdminResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy ý kiến'),
  },
})

export default router
