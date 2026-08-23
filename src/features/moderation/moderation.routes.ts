import { z } from 'zod'
import { Router } from 'express'
import { moderationController } from './moderation.controller'
import {
  requireAnyModerator,
  requireCategoryModerator,
  requireMasterPublicAxis,
} from './moderation.middleware'
import {
  modListingQuerySchema,
  modParamsSchema,
  rerouteListingSchema,
  coverageSchema,
  activityQuerySchema,
  setListingStatusSchema,
  auditEventSchema,
  overviewResponseSchema,
} from './moderation.schema'
import { listingResponseSchema } from '../listing/listing.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireOrg, requireOrgModerator } from '../../middlewares/auth.middleware'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

/*
 * Nhánh này là bàn duyệt, và nó KHÔNG đồng nhất một tầng phân quyền: mỗi route tự khai
 * middleware của trục mình, chỉ các route GET của trục org ở cuối file mới nằm dưới `router.use`
 * chung. Thứ tự khai ở đây là có nghĩa — đọc từ trên xuống.
 *
 * Đây cũng là chỗ duy nhất trả về tin ở trạng thái không public — quy tắc 7 của AGENT chỉ áp
 * cho endpoint công khai.
 */
// Trục DANH MỤC: phạm vi đến từ `role_grants` scope category_province, không từ org đang
// resolve — nên nhánh này phải khai TRƯỚC `router.use` của trục org bên dưới.
router.get(
  '/public-queue',
  authenticate,
  requireCategoryModerator,
  validate({ query: modListingQuerySchema }),
  moderationController.publicQueue,
)
router.get('/coverage', authenticate, requireMasterPublicAxis, moderationController.coverage)
router.patch(
  '/listings/:id/route',
  authenticate,
  requireMasterPublicAxis,
  validate({ params: modParamsSchema, body: rerouteListingSchema }),
  moderationController.reroute,
)

/*
 * GHI — dùng chung cho CẢ HAI trục, nên phải nằm TRÊN ranh giới org bên dưới.
 *
 * Trước đây hai route này nằm dưới `requireOrg`, và đó là lỗi khoá chặt trục công khai:
 * người phụ trách danh mục liệt kê được hàng đợi nhưng mọi cú bấm đều 403, còn master mượn
 * slug một org bất kỳ thì ăn 404 vì tenant scope lúc đó không phủ tin công khai chưa duyệt.
 * Kết quả: tin công khai của người không thuộc nhóm nào kẹt `pending` vĩnh viễn.
 */
router.patch(
  '/listings/:id',
  authenticate,
  requireAnyModerator,
  validate({ params: modParamsSchema, body: setListingStatusSchema }),
  moderationController.setListingStatus,
)
router.delete(
  '/listings/:id',
  authenticate,
  requireAnyModerator,
  validate({ params: modParamsSchema }),
  moderationController.removeListing,
)

// Trục ORG: từ đây trở xuống là bàn quản trị của một tổ chức.
router.use(authenticate, requireOrg, requireOrgModerator)

router.get('/overview', moderationController.overview)
router.get('/activity', validate({ query: activityQuerySchema }), moderationController.activity)
router.get('/listings', validate({ query: modListingQuerySchema }), moderationController.listings)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const unauthorized = errorResponse('Thiếu hoặc sai access token')
const notModerator = errorResponse('Cần quyền owner hoặc moderator')
// Thao tác ghi còn một cửa nữa sau cửa route: quyền phải khớp TRỤC của chính tin đó.
const wrongScope = errorResponse('Không có quyền duyệt, hoặc tin thuộc trục bạn không phụ trách')

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
    403: wrongScope,
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
    403: wrongScope,
    404: errorResponse('Không tìm thấy tin'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/moderation/public-queue',
  operationId: 'moderationPublicQueue',
  tags: ['Moderation'],
  summary: 'Hàng đợi duyệt của TRỤC DANH MỤC',
  description:
    'Phạm vi (danh mục × tỉnh) lấy từ role_grants của chính người gọi và được áp ở tầng ' +
    'query, không phải bộ lọc trên giao diện. Master thấy toàn bộ trục này.',
  ...protectedRoute,
  request: { query: modListingQuerySchema },
  responses: {
    200: jsonResponse('Hàng đợi', envelope(z.array(listingResponseSchema))),
    403: errorResponse('Không phụ trách danh mục nào'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/moderation/coverage',
  operationId: 'moderationCoverage',
  tags: ['Moderation'],
  summary: 'Ma trận phủ sóng (danh mục × tỉnh) cho master',
  description:
    'Chỉ trả các ô đáng chú ý: chưa có người phụ trách, hoặc đang tồn đọng. Mỗi ô trống là ' +
    'một dòng tin chảy thẳng vào hàng đợi của master.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Ma trận phủ sóng', envelope(coverageSchema)),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/moderation/listings/{id}/route',
  operationId: 'moderationRerouteListing',
  tags: ['Moderation'],
  summary: 'Chuyển tin sang ô (danh mục × tỉnh) khác',
  description: 'Tin quay về đầu hàng đợi mới và để lại vết kiểm toán.',
  ...protectedRoute,
  request: {
    params: modParamsSchema,
    body: { content: { 'application/json': { schema: rerouteListingSchema } } },
  },
  responses: {
    200: jsonResponse('Đã chuyển ô', envelope(listingResponseSchema)),
    403: errorResponse('Cần quyền master'),
  },
})

export default router
