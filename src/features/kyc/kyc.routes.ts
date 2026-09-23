import { Router } from 'express'
import { kycService } from './kyc.service'
import {
  kycDetailSchema,
  kycListQuerySchema,
  kycParamsSchema,
  kycProfileSchema,
  rejectKycSchema,
  submitKycSchema,
} from './kyc.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

export const kycController = {
  // POST /kyc/me
  submit: catchAsync(async (req, res) => {
    const data = await kycService.submit(req.user!.id, req.body)
    created(res, { message: 'Đã nộp hồ sơ định danh', data })
  }),

  // GET /kyc/me
  mine: catchAsync(async (req, res) => {
    const data = await kycService.mine(req.user!.id)
    success(res, { message: 'Hồ sơ định danh của tôi', data })
  }),

  // GET /kyc
  list: catchAsync(async (req, res) => {
    const { items, ...meta } = await kycService.list(req.query as never)
    success(res, { message: 'Hồ sơ định danh', data: items, meta })
  }),

  // GET /kyc/:id
  detail: catchAsync(async (req, res) => {
    const data = await kycService.detail(req.params.id)
    success(res, { message: 'Chi tiết hồ sơ', data })
  }),

  // PATCH /kyc/:id/approve
  approve: catchAsync(async (req, res) => {
    const data = await kycService.approve(req.user!.id, req.params.id)
    success(res, { message: 'Đã duyệt hồ sơ', data })
  }),

  // PATCH /kyc/:id/reject
  reject: catchAsync(async (req, res) => {
    const data = await kycService.reject(req.user!.id, req.params.id, req.body.reason)
    success(res, { message: 'Đã từ chối hồ sơ', data })
  }),
}

const router = Router()

/*
 * `/kyc/me` phải khai TRƯỚC `/:id` — Express khớp theo thứ tự, đăng sau thì "me" bị nuốt thành
 * một cái id rồi rụng ở validate ObjectId với lỗi 400 khó hiểu (cùng bẫy đã ghi ở `/listings`).
 *
 * Cả cụm này nằm trong `OPEN_PREFIXES` của `kycGate`: không mở thì người chưa được duyệt không
 * có cách nào nộp hồ sơ, và cái cổng tự khoá luôn chính nó.
 */
router.post('/me', authenticate, validate({ body: submitKycSchema }), kycController.submit)
router.get('/me', authenticate, kycController.mine)

router.get(
  '/',
  authenticate,
  requireMaster,
  validate({ query: kycListQuerySchema }),
  kycController.list,
)
router.get(
  '/:id',
  authenticate,
  requireMaster,
  validate({ params: kycParamsSchema }),
  kycController.detail,
)
router.patch(
  '/:id/approve',
  authenticate,
  requireMaster,
  validate({ params: kycParamsSchema }),
  kycController.approve,
)
router.patch(
  '/:id/reject',
  authenticate,
  requireMaster,
  validate({ params: kycParamsSchema, body: rejectKycSchema }),
  kycController.reject,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const KYC = ['Kyc']

registry.registerPath({
  method: 'post',
  path: '/kyc/me',
  operationId: 'submitKyc',
  tags: KYC,
  summary: 'Nộp hồ sơ định danh người bán',
  description:
    'Yêu cầu tuân thủ của Bộ Công Thương. Cá nhân: họ tên, ngày sinh, số định danh. Công ty: ' +
    'thêm tên, địa chỉ trụ sở và mã số doanh nghiệp, còn ba trường cá nhân là của NGƯỜI ĐẠI ' +
    'DIỆN THEO PHÁP LUẬT. Nộp lại sau khi bị từ chối sẽ SỬA chính hồ sơ cũ; hồ sơ đã duyệt thì ' +
    'khoá (409) — đổi số định danh sau khi duyệt là đi vòng qua chính bước duyệt.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: submitKycSchema } } } },
  responses: {
    201: jsonResponse('Đã nộp hồ sơ', envelope(kycProfileSchema)),
    400: errorResponse('Thông tin không hợp lệ'),
    409: errorResponse('Hồ sơ đã được duyệt'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/kyc/me',
  operationId: 'myKyc',
  tags: KYC,
  summary: 'Hồ sơ định danh của tôi',
  description: '`data: null` = chưa nộp — một trạng thái hợp lệ, không phải 404.',
  ...protectedRoute,
  responses: { 200: jsonResponse('Hồ sơ của tôi', envelope(kycProfileSchema.nullable())) },
})

registry.registerPath({
  method: 'get',
  path: '/kyc',
  operationId: 'listKyc',
  tags: KYC,
  summary: 'Bàn duyệt hồ sơ định danh (master)',
  description: 'Mặc định xếp CŨ TRƯỚC — hàng chờ xử theo thứ tự đến.',
  ...protectedRoute,
  request: { query: kycListQuerySchema },
  responses: {
    200: jsonResponse('Hồ sơ định danh', envelope(kycProfileSchema.array())),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/kyc/{id}',
  operationId: 'kycDetail',
  tags: KYC,
  summary: 'Chi tiết hồ sơ, kèm số định danh (master)',
  description:
    'Đường DUY NHẤT trả về `idNumber`. Mọi DTO khác cố ý không mang nó — số định danh chỉ ra ' +
    'khỏi DB khi người duyệt mở đúng một hồ sơ để đối chiếu.',
  ...protectedRoute,
  request: { params: kycParamsSchema },
  responses: {
    200: jsonResponse('Chi tiết hồ sơ', envelope(kycDetailSchema)),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy hồ sơ'),
  },
})

for (const [path, op, summary] of [
  ['/kyc/{id}/approve', 'approveKyc', 'Duyệt hồ sơ định danh (master)'],
  ['/kyc/{id}/reject', 'rejectKyc', 'Từ chối hồ sơ định danh (master)'],
] as const) {
  registry.registerPath({
    method: 'patch',
    path,
    operationId: op,
    tags: KYC,
    summary,
    ...protectedRoute,
    request: {
      params: kycParamsSchema,
      ...(op === 'rejectKyc'
        ? { body: { content: { 'application/json': { schema: rejectKycSchema } } } }
        : {}),
    },
    responses: {
      200: jsonResponse(summary, envelope(kycProfileSchema)),
      403: errorResponse('Cần quyền master'),
      404: errorResponse('Không tìm thấy hồ sơ'),
    },
  })
}

export default router
