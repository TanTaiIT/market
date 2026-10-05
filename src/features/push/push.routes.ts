import { z } from 'zod'
import { Router } from 'express'
import { pushController } from './push.controller'
import {
  pushDeviceResponseSchema,
  pushPreferencesResponseSchema,
  pushTestResponseSchema,
  registerPushDeviceSchema,
  unregisterPushDeviceSchema,
  updatePushPreferencesSchema,
} from './push.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { apiLimiter, createRateLimiter } from '../../middlewares/rateLimiter.middleware'
import { registry, bearerAuth, envelope, errorResponse, jsonResponse } from '../../config/openapi'

const router = Router()

/**
 * App đăng ký lại MỖI LẦN MỞ và mỗi khi token đổi — 30 lượt / giờ / người là rộng cho người thật,
 * chặt cho một vòng lặp lỗi phía app đang ghi DB liên tục.
 */
const deviceLimiter = createRateLimiter({ keyPrefix: 'rl:push-device', points: 30, duration: 3600 })
/** Push thử là để kiểm đường truyền, không phải nút bấm chơi: 5 lượt / giờ. */
const testLimiter = createRateLimiter({ keyPrefix: 'rl:push-test', points: 5, duration: 3600 })

router.post(
  '/devices',
  authenticate,
  deviceLimiter,
  validate({ body: registerPushDeviceSchema }),
  pushController.register,
)
/*
 * KHÔNG `authenticate`, có chủ ý: app gỡ máy lúc đăng xuất, mà có ca phiên đã chết trước đó
 * (refresh token hết hạn, bị thu hồi từ máy khác) — đòi token hợp lệ là để máy ấy nhận push của
 * một tài khoản nó không còn đăng nhập. Cầm được push token = đang cầm đúng cái máy đó. Token đi
 * trong BODY chứ không trên path: path nằm trong access log.
 */
router.post(
  '/devices/unregister',
  deviceLimiter,
  validate({ body: unregisterPushDeviceSchema }),
  pushController.unregister,
)
router.get('/preferences', authenticate, apiLimiter, pushController.preferences)
router.patch(
  '/preferences',
  authenticate,
  apiLimiter,
  validate({ body: updatePushPreferencesSchema }),
  pushController.updatePreferences,
)
router.post('/test', authenticate, testLimiter, pushController.test)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'post',
  path: '/push/devices',
  operationId: 'pushRegisterDevice',
  tags: ['Push'],
  summary: 'Đăng ký máy này nhận push (gọi mỗi lần mở app)',
  description:
    'Upsert theo token: máy đang thuộc tài khoản khác thì chuyển sang tài khoản đang gọi. ' +
    'Mỗi tài khoản giữ tối đa 10 máy dùng gần nhất.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: registerPushDeviceSchema } } } },
  responses: {
    200: jsonResponse('Đã đăng ký', envelope(pushDeviceResponseSchema)),
    400: errorResponse('Token hoặc dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/push/devices/unregister',
  operationId: 'pushUnregisterDevice',
  tags: ['Push'],
  summary: 'Gỡ máy này khỏi danh sách nhận push (không cần đăng nhập)',
  description: 'Gọi trước khi đăng xuất. Token không tồn tại vẫn trả 200.',
  request: { body: { content: { 'application/json': { schema: unregisterPushDeviceSchema } } } },
  responses: {
    200: jsonResponse('Đã gỡ', envelope(z.null())),
    400: errorResponse('Token không hợp lệ'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/push/preferences',
  operationId: 'pushGetPreferences',
  tags: ['Push'],
  summary: 'Công tắc push của tôi',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Công tắc', envelope(pushPreferencesResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/push/preferences',
  operationId: 'pushUpdatePreferences',
  tags: ['Push'],
  summary: 'Bật / tắt push theo nhóm',
  description: 'Chỉ gửi công tắc muốn đổi. Nhóm `account` không tắt được — gửi lên là 400.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: updatePushPreferencesSchema } } } },
  responses: {
    200: jsonResponse('Đã lưu', envelope(pushPreferencesResponseSchema)),
    400: errorResponse('Dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/push/test',
  operationId: 'pushSendTest',
  tags: ['Push'],
  summary: 'Gửi một push thử tới mọi máy của tôi',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Đã xếp hàng', envelope(pushTestResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    429: errorResponse('Quá nhiều request'),
    503: errorResponse('Push chưa bật trên server'),
  },
})

export default router
