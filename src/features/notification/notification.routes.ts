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
import { authenticate, requireOrg, requireOrgModerator } from '../../middlewares/auth.middleware'
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
  requireOrg,
  requireOrgModerator,
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
  operationId: 'notificationList',
  tags: ['Notification'],
  summary: 'Thông báo tôi nhận được',
  description:
    'Gồm thông báo gửi cho cả tổ chức và thông báo gửi cho đúng nhóm con của người gọi. ' +
    'Tài khoản chưa thuộc tổ chức nào nhận danh sách rỗng, không phải lỗi. ' +
    '`scope=managed` đổi câu hỏi thành "tôi gửi được tới đâu" — dùng cho bàn quản trị.',
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
  operationId: 'notificationCreate',
  tags: ['Notification'],
  summary: 'Gửi thông báo trong phạm vi organization',
  description:
    'Bỏ trống `unitId` = gửi cho cả tổ chức, cần quyền quản lý cấp org. Staff phụ trách một ' +
    'nhóm con chỉ gửi được cho đúng nhóm đó.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createNotificationSchema } } } },
  responses: {
    201: jsonResponse('Đã gửi', envelope(notificationResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    400: errorResponse('Nhóm con không tồn tại trong tổ chức này'),
    403: errorResponse('Ngoài phạm vi được cấp'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/notifications/{id}/read',
  operationId: 'notificationMarkRead',
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
