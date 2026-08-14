import { z } from 'zod'
import { Router } from 'express'
import { listingController } from './listing.controller'
import {
  createListingSchema,
  updateListingSchema,
  listingQuerySchema,
  nearbyQuerySchema,
  listingParamsSchema,
  listingResponseSchema,
} from './listing.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

// Public
router.get('/', validate({ query: listingQuerySchema }), listingController.list)
router.get('/nearby', validate({ query: nearbyQuerySchema }), listingController.nearby)

// Tin của chính mình, mọi trạng thái. PHẢI khai trước `/:id` — Express khớp theo thứ tự, đăng
// sau thì `mine` bị nuốt thành `:id` rồi rụng ở validate ObjectId với lỗi 400 khó hiểu.
router.get('/mine', authenticate, validate({ query: listingQuerySchema }), listingController.mine)

router.get('/:id', validate({ params: listingParamsSchema }), listingController.getById)

// Protected (chủ tin)
router.post(
  '/',
  authenticate,
  apiLimiter,
  validate({ body: createListingSchema }),
  listingController.create,
)
router.patch(
  '/:id',
  authenticate,
  validate({ params: listingParamsSchema, body: updateListingSchema }),
  listingController.update,
)
router.delete(
  '/:id',
  authenticate,
  validate({ params: listingParamsSchema }),
  listingController.remove,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const listingResponse = envelope(listingResponseSchema)
const listSummary = 'Chỉ trả tin ở trạng thái public — không lộ draft/pending/rejected/hidden.'

registry.registerPath({
  method: 'get',
  path: '/listings',
  operationId: 'listingList',
  tags: ['Listing'],
  summary: 'Danh sách tin đăng (filter + full-text search)',
  description: listSummary,
  request: { query: listingQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tin',
      envelope(z.array(listingResponseSchema), paginationMetaSchema),
    ),
    400: errorResponse('Query không hợp lệ'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/listings/mine',
  operationId: 'listingMine',
  tags: ['Listing'],
  summary: 'Tin của chính mình (mọi trạng thái, kể cả pending chờ duyệt)',
  description:
    'Khác /listings ở chỗ KHÔNG lọc về active — người đăng phải thấy được tin mình vừa ghim ' +
    'trong lúc nó còn nằm ở hàng đợi duyệt. Chủ tin lấy từ access token, không nhận qua query.',
  ...protectedRoute,
  request: { query: listingQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tin của bạn',
      envelope(z.array(listingResponseSchema), paginationMetaSchema),
    ),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/listings/nearby',
  operationId: 'listingNearby',
  tags: ['Listing'],
  summary: 'Tin gần một toạ độ (sắp xếp theo khoảng cách)',
  request: { query: nearbyQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tin gần đó',
      envelope(z.array(listingResponseSchema), z.object({ page: z.number(), limit: z.number() })),
    ),
    400: errorResponse('Toạ độ không hợp lệ'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/listings/{id}',
  operationId: 'listingGetById',
  tags: ['Listing'],
  summary: 'Chi tiết tin đăng (tăng viewCount)',
  description: listSummary,
  request: { params: listingParamsSchema },
  responses: {
    200: jsonResponse('Chi tiết tin', listingResponse),
    404: errorResponse('Không tìm thấy tin hoặc tin chưa được public'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/listings',
  operationId: 'listingCreate',
  tags: ['Listing'],
  summary: 'Đăng tin mới (vào trạng thái pending chờ duyệt)',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createListingSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo tin', listingResponse),
    400: errorResponse('Dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/listings/{id}',
  operationId: 'listingUpdate',
  tags: ['Listing'],
  summary: 'Sửa tin của chính mình',
  ...protectedRoute,
  request: {
    params: listingParamsSchema,
    body: { content: { 'application/json': { schema: updateListingSchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', listingResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Không phải tin của bạn'),
    404: errorResponse('Không tìm thấy tin'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/listings/{id}',
  operationId: 'listingRemove',
  tags: ['Listing'],
  summary: 'Xoá tin của chính mình (soft delete)',
  ...protectedRoute,
  request: { params: listingParamsSchema },
  responses: {
    200: jsonResponse('Đã xoá', envelope(z.null())),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Không phải tin của bạn'),
    404: errorResponse('Không tìm thấy tin'),
  },
})

export default router
