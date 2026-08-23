import { z } from 'zod'
import { Router } from 'express'
import { listingProductController } from './listing-product.controller'
import {
  createListingProductSchema,
  listingProductParamsSchema,
  listingProductResponseSchema,
  updateListingProductSchema,
} from './listing-product.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Toàn bộ là bàn quản trị catalog — master-only. Người mua xem catalog qua đường công khai
// `GET /listings/products` (chỉ trả gói đang mở bán), không phải ở đây.
router.use(authenticate, requireMaster)

router.get('/', listingProductController.list)
router.post('/', validate({ body: createListingProductSchema }), listingProductController.create)
router.patch(
  '/:id',
  validate({ params: listingProductParamsSchema, body: updateListingProductSchema }),
  listingProductController.update,
)
router.delete(
  '/:id',
  validate({ params: listingProductParamsSchema }),
  listingProductController.remove,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'get',
  path: '/listing-products',
  operationId: 'listingProductAdminList',
  tags: ['ListingProduct'],
  summary: 'Mọi gói tin, kể cả nháp (master)',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Catalog đầy đủ', envelope(z.array(listingProductResponseSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/listing-products',
  operationId: 'listingProductCreate',
  tags: ['ListingProduct'],
  summary: 'Xuất bản gói tin mới (master)',
  description:
    'Tạo gói ở trạng thái nháp (`enabled: false`) rồi bật khi sẵn sàng, hoặc tạo bật ngay — ' +
    'nhưng mở bán bắt buộc có giá. `code` là định danh bất biến (sổ cái tham chiếu bằng nó); ' +
    'mốc ưu đãi mới = một gói mới với code riêng, ví dụ `featured_7d_sale`.',
  ...protectedRoute,
  request: {
    body: { content: { 'application/json': { schema: createListingProductSchema } } },
  },
  responses: {
    201: jsonResponse('Đã tạo gói', envelope(listingProductResponseSchema)),
    400: errorResponse('Vi phạm luật gói (mở bán thiếu giá, đẩy tin kèm thời hạn…)'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    409: errorResponse('Đã có gói mang code này'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/listing-products/{id}',
  operationId: 'listingProductUpdate',
  tags: ['ListingProduct'],
  summary: 'Sửa / bật / ngừng bán một gói (master)',
  description:
    'PATCH từng phần — luật xuyên field kiểm trên bản ghép với dữ liệu đang lưu. ' +
    '`code` không sửa được: gói đổi bản chất thì tạo gói mới, ngừng bán gói cũ.',
  ...protectedRoute,
  request: {
    params: listingProductParamsSchema,
    body: { content: { 'application/json': { schema: updateListingProductSchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', envelope(listingProductResponseSchema)),
    400: errorResponse('Vi phạm luật gói'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy gói'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/listing-products/{id}',
  operationId: 'listingProductRemove',
  tags: ['ListingProduct'],
  summary: 'Xoá một gói chưa từng bán (master)',
  description: 'Gói đã bán một thời gian thì NGỪNG BÁN (`enabled: false`) thay vì xoá.',
  ...protectedRoute,
  request: { params: listingProductParamsSchema },
  responses: {
    200: jsonResponse('Đã xoá', envelope(listingProductResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy gói'),
  },
})

export default router
