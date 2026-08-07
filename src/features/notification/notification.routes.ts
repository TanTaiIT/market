import { z } from 'zod'
import { Router } from 'express'
import { notificationController } from './notification.controller'
import {
  createNotificationSchema,
  notificationQuerySchema,
  notificationParamsSchema,
  notificationResponseSchema,
} from './notification.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, authorize } from '../../middlewares/auth.middleware'
import { ORG_ROLES } from '../../common/constants'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

router.get(
  '/',
  authenticate,
  validate({ query: notificationQuerySchema }),
  notificationController.list,
)
router.post(
  '/',
  authenticate,
  authorize(ORG_ROLES.OWNER, ORG_ROLES.MODERATOR),
  validate({ body: createNotificationSchema }),
  notificationController.create,
)
router.patch(
  '/:id/read',
  authenticate,
  validate({ params: notificationParamsSchema }),
  notificationController.markRead,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'get',
  path: '/notifications',
  tags: ['Notification'],
  summary: 'Thông báo của organization hiện tại (gồm cả bản fan-out từ chain)',
  ...protectedRoute,
  request: { query: notificationQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách thông báo',
      envelope(z.array(notificationResponseSchema), paginationMetaSchema),
    ),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/notifications',
  tags: ['Notification'],
  summary: 'Gửi thông báo trong phạm vi organization',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createNotificationSchema } } } },
  responses: {
    201: jsonResponse('Đã gửi', envelope(notificationResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Chỉ owner/moderator được gửi'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/notifications/{id}/read',
  tags: ['Notification'],
  summary: 'Đánh dấu đã đọc',
  ...protectedRoute,
  request: { params: notificationParamsSchema },
  responses: {
    200: jsonResponse('Đã đánh dấu', envelope(notificationResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    404: errorResponse('Không tìm thấy thông báo'),
  },
})

export default router
