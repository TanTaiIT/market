import { z } from 'zod'
import { Router } from 'express'
import { supportController } from './support.controller'
import {
  myThreadSchema,
  sendSupportSchema,
  supportParamsSchema,
  supportQueueItemSchema,
  supportQueueQuerySchema,
  supportThreadSchema,
} from './support.schema'
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

/*
 * Kênh hỗ trợ KHÔNG đọc `X-Org-Id`: đây là đường giữa một người và đội ngũ nền tảng, không
 * thuộc tổ chức nào. Người chưa vào nhóm nào vẫn phải nhắn được — mà đó chính là nhóm hay cần
 * hỏi nhất.
 */

// ── Phía người dùng ─────────────────────────────────────────────────────────
router.get('/me', authenticate, supportController.myThread)
router.post(
  '/me/messages',
  authenticate,
  // Phanh: đây là ô nhập tự do gửi thẳng tới người thật, không qua bước duyệt nào.
  apiLimiter,
  validate({ body: sendSupportSchema }),
  supportController.send,
)
router.post('/me/read', authenticate, supportController.markRead)

// ── Phía master ─────────────────────────────────────────────────────────────
router.get(
  '/threads',
  authenticate,
  requireMaster,
  validate({ query: supportQueueQuerySchema }),
  supportController.queue,
)
router.get(
  '/threads/:id',
  authenticate,
  requireMaster,
  validate({ params: supportParamsSchema }),
  supportController.threadForMaster,
)
router.post(
  '/threads/:id/reply',
  authenticate,
  requireMaster,
  apiLimiter,
  validate({ params: supportParamsSchema, body: sendSupportSchema }),
  supportController.reply,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const unauthorized = errorResponse('Thiếu hoặc sai access token')
const needMaster = errorResponse('Cần quyền master')

registry.registerPath({
  method: 'get',
  path: '/support/me',
  operationId: 'supportMyThread',
  tags: ['Support'],
  summary: 'Luồng trao đổi của chính mình với đội ngũ hỗ trợ',
  description:
    'Chưa nhắn bao giờ thì trả luồng RỖNG (`id: null`, `messages: []`), không phải 404 — ' +
    'client dùng một hình dạng dữ liệu cho cả hai trạng thái. Đọc `unread` để bật chấm đỏ ' +
    'trên icon hỗ trợ.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Luồng của tôi', envelope(myThreadSchema)),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'post',
  path: '/support/me/messages',
  operationId: 'supportSend',
  tags: ['Support'],
  summary: 'Gửi một tin cho đội ngũ hỗ trợ',
  description:
    'Mỗi người có ĐÚNG MỘT luồng, tạo tự động ở lần gửi đầu tiên. Nội dung đi qua cổng cụm ' +
    'từ cấm như mọi bề mặt nhập liệu khác.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: sendSupportSchema } } } },
  responses: {
    200: jsonResponse('Đã gửi', envelope(myThreadSchema)),
    400: errorResponse('Nội dung quá ngắn, quá dài, hoặc chứa cụm từ cấm'),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'post',
  path: '/support/me/read',
  operationId: 'supportMarkRead',
  tags: ['Support'],
  summary: 'Đánh dấu đã đọc câu trả lời của master',
  description: 'Tắt chấm đỏ. Gọi được cả khi chưa có luồng nào — không phải lỗi.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Đã đánh dấu', envelope(z.object({ unread: z.boolean() }))),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'get',
  path: '/support/threads',
  operationId: 'supportQueue',
  tags: ['Support'],
  summary: 'Hàng đợi hỗ trợ (master)',
  description:
    'Mặc định chỉ trả luồng ĐANG CHỜ trả lời (`waiting=true`) — gửi `waiting=false` để xem ' +
    'toàn bộ. Không kèm `messages`: danh sách chỉ cần dòng xem trước.',
  ...protectedRoute,
  request: { query: supportQueueQuerySchema },
  responses: {
    200: jsonResponse('Hàng đợi', envelope(z.array(supportQueueItemSchema), paginationMetaSchema)),
    401: unauthorized,
    403: needMaster,
  },
})

registry.registerPath({
  method: 'get',
  path: '/support/threads/{id}',
  operationId: 'supportThread',
  tags: ['Support'],
  summary: 'Đọc một luồng hỗ trợ (master)',
  description: 'Mở ra là đánh dấu master đã xem, nên luồng rời khỏi hàng đợi.',
  ...protectedRoute,
  request: { params: supportParamsSchema },
  responses: {
    200: jsonResponse('Luồng', envelope(supportThreadSchema)),
    401: unauthorized,
    403: needMaster,
    404: errorResponse('Không tìm thấy luồng hỗ trợ này'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/support/threads/{id}/reply',
  operationId: 'supportReply',
  tags: ['Support'],
  summary: 'Master trả lời một luồng',
  description: 'Sau lệnh này, người dùng của luồng thấy chấm đỏ trên icon hỗ trợ.',
  ...protectedRoute,
  request: {
    params: supportParamsSchema,
    body: { content: { 'application/json': { schema: sendSupportSchema } } },
  },
  responses: {
    200: jsonResponse('Đã trả lời', envelope(supportThreadSchema)),
    400: errorResponse('Nội dung không hợp lệ'),
    401: unauthorized,
    403: needMaster,
    404: errorResponse('Không tìm thấy luồng hỗ trợ này'),
  },
})

export default router
