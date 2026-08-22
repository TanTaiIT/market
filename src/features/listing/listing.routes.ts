import { z } from 'zod'
import { Router } from 'express'
import { listingController } from './listing.controller'
import {
  createListingSchema,
  quotaStatusSchema,
  updateListingSchema,
  listingQuerySchema,
  nearbyQuerySchema,
  listingParamsSchema,
  listingResponseSchema,
  postingStatsQuerySchema,
  postingStatsSchema,
  postingFeeSchema,
  listingProductSchema,
} from './listing.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
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
// Trạng thái quota — client hiện "còn N slot" thay vì để người dùng đoán vì sao bị chặn (§8.4).
router.get('/quota', authenticate, listingController.quota)

// Catalog gói tin — công khai: giá bán là thông tin cho khách, không phải bí mật.
router.get('/products', listingController.products)

// Dữ liệu định giá cho hệ Xu — master-only, và phải đứng TRƯỚC '/:id' kẻo Express nuốt
// 'posting-stats' làm một cái id.
router.get(
  '/posting-stats',
  authenticate,
  requireMaster,
  validate({ query: postingStatsQuerySchema }),
  listingController.postingStats,
)

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
// Riêng create: meta mang biên lai phí của HÀNH ĐỘNG — spec phải nói đúng thứ runtime trả.
const listingCreatedResponse = envelope(listingResponseSchema, z.object({ fee: postingFeeSchema }))
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
  summary: 'Tin cùng khu vực (xã trước, rồi tới tỉnh)',
  description:
    'Không dùng toạ độ: "gần" ở đây là cùng địa giới hành chính. Lọc trong `province`, tin ' +
    'cùng `ward` được xếp lên trước — không lọc cứng theo xã vì xã thưa tin sẽ ra màn rỗng. ' +
    'Truyền `exclude` là id tin đang xem để nó không tự hiện trong danh sách của chính mình.',
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
    201: jsonResponse('Đã tạo tin', listingCreatedResponse),
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
  description:
    'Đổi tiêu đề, mô tả, giá, ảnh hay danh mục của một tin ĐANG HIỂN THỊ sẽ đưa tin về `pending` để duyệt lại — trừ khi người bán đủ bậc uy tín tự đăng. Đọc `status` trong response để biết tin còn trên bảng hay không.',
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

registry.registerPath({
  method: 'get',
  path: '/listings/quota',
  operationId: 'listingQuota',
  tags: ['Listing'],
  summary: 'Còn bao nhiêu slot đăng tin',
  description:
    'Hiện trạng quota để client nói rõ "bạn có N/M tin chờ duyệt" — thiếu nó thì khi người ' +
    'duyệt bận cả tuần, người dùng chỉ thấy mình bị chặn mà không hiểu vì sao.',
  ...protectedRoute,
  responses: { 200: jsonResponse('Trạng thái quota', envelope(quotaStatusSchema)) },
})

registry.registerPath({
  method: 'get',
  path: '/listings/products',
  operationId: 'listingProducts',
  tags: ['Listing'],
  summary: 'Catalog gói tin (đẩy tin, tin nổi bật…)',
  description:
    'Danh sách gói trả bằng Xu áp lên một tin. `enabled: false` + `price: null` = chưa mở ' +
    'bán — FE dựng UI trước, ngày mở bán chỉ là dữ liệu đổi. Đường mua sẽ là ' +
    '`POST /listings/{id}/products/{code}` khi ví Xu vận hành.',
  responses: {
    200: jsonResponse('Catalog gói tin', envelope(z.array(listingProductSchema))),
  },
})

registry.registerPath({
  method: 'get',
  path: '/listings/posting-stats',
  operationId: 'listingPostingStats',
  tags: ['Listing'],
  summary: 'Số liệu đăng tin toàn nền tảng (master)',
  description:
    'Dữ liệu định giá cho hệ Xu, tích luỹ từ giai đoạn miễn phí: tổng lượt đăng, số người ' +
    'đăng, phân bố theo danh mục, và biểu đồ ai-đăng-bao-nhiêu — nhóm 4+ tin/cửa sổ là nhóm ' +
    'sẽ trả phí. Đếm mọi tin được TẠO (kể cả bị từ chối): thứ cần đo là nhu cầu.',
  ...protectedRoute,
  request: { query: postingStatsQuerySchema },
  responses: {
    200: jsonResponse('Số liệu đăng tin', envelope(postingStatsSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

export default router
