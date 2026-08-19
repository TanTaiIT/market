import { z } from 'zod'
import { Router } from 'express'
import { favoriteController } from './favorite.controller'
import { favoriteParamsSchema, favoriteQuerySchema, favoriteStatusSchema } from './favorite.schema'
import { listingResponseSchema } from '../listing/listing.schema'
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

// Toàn bộ feature cần đăng nhập: tin đã lưu gắn với tài khoản, không có bản của khách.
router.get('/', authenticate, validate({ query: favoriteQuerySchema }), favoriteController.list)

// PHẢI đứng trước các route `/:listingId` — Express khớp theo thứ tự, đăng sau thì `ids` bị
// nuốt thành một `listingId` rồi rụng ở validate ObjectId với lỗi 400 khó hiểu.
router.get('/ids', authenticate, favoriteController.ids)

router.post(
  '/:listingId',
  authenticate,
  apiLimiter,
  validate({ params: favoriteParamsSchema }),
  favoriteController.add,
)
router.delete(
  '/:listingId',
  authenticate,
  validate({ params: favoriteParamsSchema }),
  favoriteController.remove,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const favoriteStatus = envelope(favoriteStatusSchema)
const unauthorized = errorResponse('Thiếu hoặc sai access token')

registry.registerPath({
  method: 'get',
  path: '/favorites',
  operationId: 'favoriteList',
  tags: ['Favorite'],
  summary: 'Danh sách tin đã lưu (mới lưu trước)',
  description:
    'Chỉ trả tin còn đọc được: tin đã gỡ hoặc ngoài phạm vi của bạn bị loại khỏi `data`, ' +
    'nhưng `meta.total` vẫn đếm đủ bản ghi đã lưu — một trang có thể ngắn hơn `limit`.',
  ...protectedRoute,
  request: { query: favoriteQuerySchema },
  responses: {
    200: jsonResponse('Tin đã lưu', envelope(z.array(listingResponseSchema), paginationMetaSchema)),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'get',
  path: '/favorites/ids',
  operationId: 'favoriteIds',
  tags: ['Favorite'],
  summary: 'Id các tin đã lưu',
  description:
    'Không phân trang: client cần đủ tập này để tô tim trên mọi danh sách đang mở, mà tô ' +
    'thiếu một cái tim thì người dùng tưởng đã mất tin đã lưu.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Id tin đã lưu', envelope(z.array(z.string()))),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'post',
  path: '/favorites/{listingId}',
  operationId: 'favoriteAdd',
  tags: ['Favorite'],
  summary: 'Lưu một tin',
  description:
    'Idempotent: bấm lại lần hai vẫn 201 và vẫn `favorited: true`, không tạo thêm bản ghi và ' +
    'không cộng thêm `favoriteCount`.',
  ...protectedRoute,
  request: { params: favoriteParamsSchema },
  responses: {
    201: jsonResponse('Đã lưu', favoriteStatus),
    401: unauthorized,
    404: errorResponse('Không tìm thấy tin hoặc tin ngoài phạm vi của bạn'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/favorites/{listingId}',
  operationId: 'favoriteRemove',
  tags: ['Favorite'],
  summary: 'Bỏ lưu một tin',
  description:
    'Idempotent, và KHÔNG kiểm tin còn tồn tại: tin đã bị gỡ vẫn bỏ tim được, nếu không người ' +
    'dùng kẹt vĩnh viễn với một bản ghi họ không xoá nổi.',
  ...protectedRoute,
  request: { params: favoriteParamsSchema },
  responses: {
    200: jsonResponse('Đã bỏ lưu', favoriteStatus),
    401: unauthorized,
  },
})

export default router
