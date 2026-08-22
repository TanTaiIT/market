import { z } from 'zod'
import { Router } from 'express'
import { inviteController } from './invite.controller'
import {
  acceptInviteResponseSchema,
  createInviteResponseSchema,
  createInviteSchema,
  invitePreviewSchema,
  inviteParamsSchema,
  inviteResponseSchema,
  inviteTokenParamsSchema,
  myInviteSchema,
} from './invite.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireOrg, requireOrgAdmin } from '../../middlewares/auth.middleware'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// ── Người được mời ──────────────────────────────────────────────────────────
// PHẢI khai trước `/:id`: đăng sau thì `mine` và `token` bị nuốt thành id rồi rụng ở validate.
router.get('/mine', authenticate, inviteController.mine)

router.get('/token/:token', validate({ params: inviteTokenParamsSchema }), inviteController.preview)
router.post(
  '/token/:token/accept',
  authenticate,
  validate({ params: inviteTokenParamsSchema }),
  inviteController.accept,
)

// ── Bàn quản trị của org ────────────────────────────────────────────────────
router.post(
  '/',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  apiLimiter,
  validate({ body: createInviteSchema }),
  inviteController.create,
)
router.get('/', authenticate, requireOrg, requireOrgAdmin, inviteController.list)
router.delete(
  '/:id',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ params: inviteParamsSchema }),
  inviteController.revoke,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const unauthorized = errorResponse('Thiếu hoặc sai access token')
const notAdmin = errorResponse('Cần quyền quản lý tổ chức')

registry.registerPath({
  method: 'post',
  path: '/invites',
  operationId: 'inviteCreate',
  tags: ['Invite'],
  summary: 'Mời một người vào tổ chức đang hoạt động',
  description:
    'Hệ thống KHÔNG gửi mail hay SMS. Tra ra đúng một tài khoản thì lời mời đến qua thông báo ' +
    'trong app (`kind: direct`); không tra ra ai thì trả về link để admin tự gửi ' +
    '(`kind: link`, `shareable: true`). `token` chỉ xuất hiện ở response này, DB chỉ giữ bản băm.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createInviteSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo lời mời', envelope(createInviteResponseSchema)),
    401: unauthorized,
    403: notAdmin,
    409: errorResponse('Đã là thành viên, hoặc đã có lời mời đang chờ cho địa chỉ này'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/invites',
  operationId: 'inviteList',
  tags: ['Invite'],
  summary: 'Đã mời ai, ai chưa trả lời',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Danh sách lời mời', envelope(z.array(inviteResponseSchema))),
    401: unauthorized,
    403: notAdmin,
  },
})

registry.registerPath({
  method: 'delete',
  path: '/invites/{id}',
  operationId: 'inviteRevoke',
  tags: ['Invite'],
  summary: 'Thu hồi một lời mời còn chờ',
  ...protectedRoute,
  request: { params: inviteParamsSchema },
  responses: {
    200: jsonResponse('Đã thu hồi', envelope(inviteResponseSchema)),
    400: errorResponse('Lời mời này đã được xử lý rồi'),
    401: unauthorized,
    403: notAdmin,
    404: errorResponse('Không tìm thấy lời mời'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/invites/mine',
  operationId: 'inviteMine',
  tags: ['Invite'],
  summary: 'Lời mời đích danh gửi cho tôi',
  description:
    'Chỉ lời mời `direct` còn hiệu lực. Không có `value`: người nhận đã biết địa chỉ của chính ' +
    'mình, hiện ra chỉ tạo cửa lộ email/số của người khác khi admin gõ nhầm.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Lời mời của tôi', envelope(z.array(myInviteSchema))),
    401: unauthorized,
  },
})

registry.registerPath({
  method: 'get',
  path: '/invites/token/{token}',
  operationId: 'invitePreview',
  tags: ['Invite'],
  summary: 'Xem lời mời trước khi đăng nhập (công khai)',
  request: { params: inviteTokenParamsSchema },
  responses: {
    200: jsonResponse('Thẻ lời mời', envelope(invitePreviewSchema)),
    400: errorResponse('Lời mời đã dùng, đã bị thu hồi, hoặc đã hết hạn'),
    404: errorResponse('Lời mời không tồn tại'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/invites/token/{token}/accept',
  operationId: 'inviteAccept',
  tags: ['Invite'],
  summary: 'Nhận lời mời và vào nhóm',
  description:
    'Vào THẲNG, không qua hàng đợi duyệt đơn: người trong tổ chức đã chủ động gọi tên bạn rồi. ' +
    'Lời mời `direct` chỉ đúng người được mời nhận được; lời mời `link` thì ai cầm link cũng vào.',
  ...protectedRoute,
  request: { params: inviteTokenParamsSchema },
  responses: {
    200: jsonResponse('Đã vào nhóm', envelope(acceptInviteResponseSchema)),
    400: errorResponse('Lời mời đã dùng, đã bị thu hồi, hoặc đã hết hạn'),
    401: unauthorized,
    403: errorResponse('Lời mời này dành cho người khác'),
    404: errorResponse('Lời mời không tồn tại'),
  },
})

export default router
