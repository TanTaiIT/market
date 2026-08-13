import { z } from 'zod'
import { Router } from 'express'
import { chatController } from './chat.controller'
import {
  openConversationSchema,
  sendMessageSchema,
  conversationParamsSchema,
  conversationQuerySchema,
  conversationResponseSchema,
  messageResponseSchema,
} from './chat.schema'
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

// Không có route công khai nào: hội thoại luôn thuộc về hai người cụ thể.
router.post(
  '/',
  authenticate,
  apiLimiter,
  validate({ body: openConversationSchema }),
  chatController.open,
)
router.get('/', authenticate, validate({ query: conversationQuerySchema }), chatController.list)
router.get(
  '/:id',
  authenticate,
  validate({ params: conversationParamsSchema }),
  chatController.getById,
)
router.get(
  '/:id/messages',
  authenticate,
  validate({ params: conversationParamsSchema, query: conversationQuerySchema }),
  chatController.messages,
)
router.post(
  '/:id/messages',
  authenticate,
  apiLimiter,
  validate({ params: conversationParamsSchema, body: sendMessageSchema }),
  chatController.send,
)
router.patch(
  '/:id/read',
  authenticate,
  validate({ params: conversationParamsSchema }),
  chatController.markRead,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const conversationResponse = envelope(conversationResponseSchema)
const notMember = errorResponse('Không tìm thấy hội thoại, hoặc bạn không thuộc hội thoại này')
const unauthorized = errorResponse('Thiếu hoặc sai access token')

registry.registerPath({
  method: 'post',
  path: '/chats',
  operationId: 'chatOpen',
  tags: ['Chat'],
  summary: 'Mở hội thoại với người bán của một tin (trả lại hội thoại cũ nếu đã có)',
  description:
    'Chỉ nhắn được trong cùng organization. Tin của trường khác trong hệ thống vẫn xem được ' +
    'nhưng chưa mở chat xuyên trường.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: openConversationSchema } } } },
  responses: {
    201: jsonResponse('Hội thoại', conversationResponse),
    400: errorResponse('Đây là tin của bạn'),
    401: unauthorized,
    403: errorResponse('Người bán ở trường khác'),
    404: errorResponse('Không tìm thấy tin'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/chats',
  operationId: 'chatList',
  tags: ['Chat'],
  summary: 'Danh sách hội thoại của tôi, mới nhất trước',
  ...protectedRoute,
  request: { query: conversationQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách hội thoại',
      envelope(z.array(conversationResponseSchema), paginationMetaSchema),
    ),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'get',
  path: '/chats/{id}',
  operationId: 'chatGetById',
  tags: ['Chat'],
  summary: 'Chi tiết một hội thoại',
  ...protectedRoute,
  request: { params: conversationParamsSchema },
  responses: {
    200: jsonResponse('Hội thoại', conversationResponse),
    401: unauthorized,
    404: notMember,
  },
})

registry.registerPath({
  method: 'get',
  path: '/chats/{id}/messages',
  operationId: 'chatMessages',
  tags: ['Chat'],
  summary: 'Lịch sử tin nhắn, mới nhất trước',
  ...protectedRoute,
  request: { params: conversationParamsSchema, query: conversationQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tin nhắn',
      envelope(z.array(messageResponseSchema), paginationMetaSchema),
    ),
    401: unauthorized,
    404: notMember,
  },
})

registry.registerPath({
  method: 'post',
  path: '/chats/{id}/messages',
  operationId: 'chatSend',
  tags: ['Chat'],
  summary: 'Gửi tin nhắn',
  description:
    'Đường ghi duy nhất. Socket.IO chỉ phát lại tin đã lưu tới phòng ' +
    '`org:<organizationId>:conversation:<id>`, client không ghi qua socket.',
  ...protectedRoute,
  request: {
    params: conversationParamsSchema,
    body: { content: { 'application/json': { schema: sendMessageSchema } } },
  },
  responses: {
    201: jsonResponse('Đã gửi', envelope(messageResponseSchema)),
    400: errorResponse('Nội dung rỗng hoặc quá dài'),
    401: unauthorized,
    404: notMember,
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/chats/{id}/read',
  operationId: 'chatMarkRead',
  tags: ['Chat'],
  summary: 'Đánh dấu đã đọc tới thời điểm hiện tại',
  ...protectedRoute,
  request: { params: conversationParamsSchema },
  responses: {
    200: jsonResponse('Đã cập nhật', conversationResponse),
    401: unauthorized,
    404: notMember,
  },
})

export default router
