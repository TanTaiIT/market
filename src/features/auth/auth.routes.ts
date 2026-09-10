import { z } from 'zod'
import { Router } from 'express'
import { authController } from './auth.controller'
import { registerSchema, loginSchema, refreshSchema, authResponseSchema } from './auth.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authLimiter } from '../../middlewares/rateLimiter.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Rate limit chặt để chống brute-force
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login)
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh)

/*
 * Đăng xuất — cần access token hợp lệ, KHÔNG nhận refresh token trong body.
 *
 * Nếu nhận refresh token thì ai nhặt được nó cũng đăng xuất được chủ tài khoản: một cú DoS
 * nhắm vào đúng một người, miễn phí. Bắt `authenticate` nghĩa là chỉ người đang có phiên
 * sống mới cắt được phiên của chính mình.
 */
router.post('/logout', authenticate, authController.logout)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
// `operationId` là tên hàm client sau codegen -> phải ổn định và độc lập với path,
// đổi path không được kéo theo đổi tên hàm ở mọi consumer.
const authResponse = envelope(authResponseSchema)

registry.registerPath({
  method: 'post',
  path: '/auth/register',
  operationId: 'authRegister',
  tags: ['Auth'],
  summary: 'Tạo Organization mới + tài khoản owner đầu tiên',
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: {
    201: jsonResponse('Đăng ký thành công', authResponse),
    400: errorResponse('Dữ liệu không hợp lệ'),
    409: errorResponse('Organization slug đã tồn tại'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  operationId: 'authLogin',
  tags: ['Auth'],
  summary: 'Đăng nhập trong phạm vi một Organization (subdomain hoặc orgSlug)',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: jsonResponse('Đăng nhập thành công', authResponse),
    401: errorResponse('Sai thông tin đăng nhập, tài khoản bị khoá, hoặc thiếu organization'),
    403: errorResponse('Organization không tồn tại hoặc đã bị khoá'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/refresh',
  operationId: 'authRefresh',
  tags: ['Auth'],
  summary: 'Lấy cặp token mới từ refresh token',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: jsonResponse('Token đã được làm mới', authResponse),
    401: errorResponse('Refresh token hết hạn hoặc không hợp lệ'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  operationId: 'authLogout',
  tags: ['Auth'],
  summary: 'Đăng xuất khỏi MỌI thiết bị',
  description:
    'Tăng `tokenVersion` của tài khoản, làm chết mọi refresh token đã phát — kể cả token ' +
    'đang nằm trên máy khác. Access token đang cầm vẫn sống tối đa tới hạn của nó (15 phút); ' +
    'đó là cái giá của việc không đọc DB ở mọi request. Không có đăng xuất từng thiết bị: ' +
    'refresh token là bearer stateless, muốn tách theo thiết bị thì phải có bảng lưu `jti`.',
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: jsonResponse('Đã đăng xuất', envelope(z.null())),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

export default router
