import { z } from 'zod'
import { Router } from 'express'
import { userController } from './user.controller'
import {
  adminUserQuerySchema,
  adminUserSchema,
  setUserStatusSchema,
  updateProfileSchema,
  userParamsSchema,
  publicProfileSchema,
  meProfileSchema,
} from './user.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

router.get('/me', authenticate, userController.getMe)
router.patch('/me', authenticate, validate({ body: updateProfileSchema }), userController.updateMe)
router.delete('/me', authenticate, userController.deleteMe)

router.get('/:id', validate({ params: userParamsSchema }), userController.getById)

// ── Vận hành hệ thống (master) ──────────────────────────────────────────────
// Khoá tài khoản là quyền của master, KHÔNG phải admin org: tài khoản là toàn cục, một org
// khoá được nó là với tay sang mọi org khác — xem `userService.setStatus`.
router.get(
  '/',
  authenticate,
  requireMaster,
  validate({ query: adminUserQuerySchema }),
  userController.listForAdmin,
)
router.patch(
  '/:id/status',
  authenticate,
  requireMaster,
  validate({ params: userParamsSchema, body: setUserStatusSchema }),
  userController.setStatus,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const meResponse = envelope(meProfileSchema)

registry.registerPath({
  method: 'get',
  path: '/users/me',
  operationId: 'userGetMe',
  tags: ['User'],
  summary: 'Hồ sơ của chính mình',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Thông tin user hiện tại', meResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/users/me',
  operationId: 'userUpdateMe',
  tags: ['User'],
  summary: 'Cập nhật hồ sơ của chính mình',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: updateProfileSchema } } } },
  responses: {
    200: jsonResponse('Đã cập nhật', meResponse),
    400: errorResponse('Dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/users/me',
  operationId: 'userDeleteMe',
  tags: ['User'],
  summary: 'Xoá tài khoản (soft delete)',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Đã xoá tài khoản', envelope(z.null())),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/users/{id}',
  operationId: 'userGetById',
  tags: ['User'],
  summary: 'Hồ sơ công khai của người bán',
  request: { params: userParamsSchema },
  responses: {
    200: jsonResponse('Hồ sơ công khai', envelope(publicProfileSchema)),
    404: errorResponse('Không tìm thấy user'),
  },
})

export default router

registry.registerPath({
  method: 'get',
  path: '/users',
  operationId: 'userListForAdmin',
  tags: ['User'],
  summary: 'Bảng người dùng (master)',
  description:
    'Kèm email, trạng thái khoá và bậc uy tín — màn quản trị cần định danh thật để khoá đúng ' +
    'người. `q` khớp tiền tố email hoặc một phần tên.',
  security: [{ [bearerAuth.name]: [] }],
  request: { query: adminUserQuerySchema },
  responses: {
    200: jsonResponse('Danh sách người dùng', envelope(z.array(adminUserSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/users/{id}/status',
  operationId: 'userSetStatus',
  tags: ['User'],
  summary: 'Khoá / mở khoá tài khoản (master)',
  description:
    'Khoá bắt buộc nêu lý do; lý do đến tay người bị khoá qua thông báo. Khoá thì ẨN luôn mọi ' +
    'tin còn sống của họ (kể cả tin chờ duyệt); mở khoá KHÔNG tự hiện lại — người dùng tự mở ' +
    'từng tin. Đăng nhập/refresh chặn ngay; access token đang sống chạy nốt tối đa 15 phút. ' +
    'Không khoá được chính mình và người đang giữ quyền master.',
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: userParamsSchema,
    body: { content: { 'application/json': { schema: setUserStatusSchema } } },
  },
  responses: {
    200: jsonResponse('Trạng thái mới', envelope(adminUserSchema)),
    400: errorResponse('Thiếu lý do khoá, hoặc tự khoá chính mình'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy người dùng'),
    409: errorResponse('Trạng thái không đổi, hoặc người này đang giữ quyền master'),
  },
})
