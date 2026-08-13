import { z } from 'zod'
import { Router } from 'express'
import { moderationController } from './moderation.controller'
import {
  modListingQuerySchema,
  modParamsSchema,
  activityQuerySchema,
  setListingStatusSchema,
  auditEventSchema,
  overviewResponseSchema,
} from './moderation.schema'
import { listingResponseSchema } from '../listing/listing.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, authorize } from '../../middlewares/auth.middleware'
import { ORG_ROLES } from '../../common/constants'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

/**
 * Toàn bộ nhánh này là bàn quản trị của **một trường**: `authenticate` đã ràng token vào đúng
 * org đang resolve, `authorize` chặn thành viên thường. Đây cũng là chỗ duy nhất trả về tin ở
 * trạng thái không public — quy tắc 7 của AGENT chỉ áp cho endpoint công khai.
 */
router.use(authenticate, authorize(ORG_ROLES.OWNER, ORG_ROLES.MODERATOR))

router.get('/overview', moderationController.overview)
router.get('/activity', validate({ query: activityQuerySchema }), moderationController.activity)
router.get('/listings', validate({ query: modListingQuerySchema }), moderationController.listings)
router.patch(
  '/listings/:id',
  validate({ params: modParamsSchema, body: setListingStatusSchema }),
  moderationController.setListingStatus,
)
router.delete(
  '/listings/:id',
  validate({ params: modParamsSchema }),
  moderationController.removeListing,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const unauthorized = errorResponse('Thiếu hoặc sai access token')
const notModerator = errorResponse('Cần quyền owner hoặc moderator')

registry.registerPath({
  method: 'get',
  path: '/moderation/overview',
  operationId: 'moderationOverview',
  tags: ['Moderation'],
  summary: 'Thẻ số + biểu đồ 14 ngày + phân bố danh mục cho màn tổng quan',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Số liệu tổng quan', envelope(overviewResponseSchema)),
    401: unauthorized,
    403: notModerator,
  },
})

registry.registerPath({
  method: 'get',
  path: '/moderation/activity',
  operationId: 'moderationActivity',
  tags: ['Moderation'],
  summary: 'Dòng "Vừa diễn ra" — vết kiểm toán thao tác quản trị',
  description: 'Realtime đi kèm: sự kiện mới phát qua Socket.IO event `admin:activity`.',
  ...protectedRoute,
  request: { query: activityQuerySchema },
  responses: {
    200: jsonResponse('Dòng sự kiện', envelope(z.array(auditEventSchema), paginationMetaSchema)),
    401: unauthorized,
    403: notModerator,
  },
})

registry.registerPath({
  method: 'get',
  path: '/moderation/listings',
  operationId: 'moderationListings',
  tags: ['Moderation'],
  summary: 'Tin theo trạng thái, gồm cả pending/rejected/hidden',
  ...protectedRoute,
  request: { query: modListingQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tin',
      envelope(z.array(listingResponseSchema), paginationMetaSchema),
    ),
    401: unauthorized,
    403: notModerator,
  },
})

registry.registerPath({
  method: 'patch',
  path: '/moderation/listings/{id}',
  operationId: 'moderationSetListingStatus',
  tags: ['Moderation'],
  summary: 'Ghim / từ chối / ẩn một tin',
  description: 'Từ chối bắt buộc kèm `reason` — người đăng sẽ đọc lý do đó.',
  ...protectedRoute,
  request: {
    params: modParamsSchema,
    body: { content: { 'application/json': { schema: setListingStatusSchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', envelope(listingResponseSchema)),
    400: errorResponse('Từ chối mà thiếu lý do'),
    401: unauthorized,
    403: notModerator,
    404: errorResponse('Không tìm thấy tin'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/moderation/listings/{id}',
  operationId: 'moderationRemoveListing',
  tags: ['Moderation'],
  summary: 'Gỡ tin khỏi bảng (soft delete)',
  ...protectedRoute,
  request: { params: modParamsSchema },
  responses: {
    200: jsonResponse('Đã gỡ', envelope(z.null())),
    401: unauthorized,
    403: notModerator,
    404: errorResponse('Không tìm thấy tin'),
  },
})

export default router
