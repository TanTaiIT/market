import { Router } from 'express'
import { authController } from './auth.controller'
import { registerSchema, loginSchema, refreshSchema, authResponseSchema } from './auth.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authLimiter } from '../../middlewares/rateLimiter.middleware'
import { registry, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Rate limit chặt để chống brute-force
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login)
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh)

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

export default router
