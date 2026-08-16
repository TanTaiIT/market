import { z } from 'zod'
import { Router } from 'express'
import { joinRequestController } from './join-request.controller'
import {
  createJoinRequestSchema,
  joinRequestParamsSchema,
  joinRequestQuerySchema,
  joinRequestResponseSchema,
  myJoinRequestResponseSchema,
  approveJoinRequestSchema,
  rejectJoinRequestSchema,
  bulkApproveSchema,
} from './join-request.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireOrg, requireOrgModerator } from '../../middlewares/auth.middleware'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// ── Người gửi đơn ───────────────────────────────────────────────────────────
// Cố tình KHÔNG đòi org scope: người gửi theo định nghĩa chưa thuộc org nào, org đến từ
// `orgSlug` trong body — cái slug họ vừa xác nhận trên dropdown.
router.post(
  '/',
  authenticate,
  apiLimiter,
  validate({ body: createJoinRequestSchema }),
  joinRequestController.create,
)
router.get('/mine', authenticate, joinRequestController.mine)
router.delete(
  '/:id',
  authenticate,
  validate({ params: joinRequestParamsSchema }),
  joinRequestController.cancel,
)

// ── Người duyệt ─────────────────────────────────────────────────────────────
// `/bulk-approve` phải khai TRƯỚC `/:id/*`: Express khớp theo thứ tự.
router.post(
  '/bulk-approve',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ body: bulkApproveSchema }),
  joinRequestController.bulkApprove,
)
router.get(
  '/',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ query: joinRequestQuerySchema }),
  joinRequestController.list,
)
router.patch(
  '/:id/approve',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ params: joinRequestParamsSchema, body: approveJoinRequestSchema }),
  joinRequestController.approve,
)
router.patch(
  '/:id/reject',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ params: joinRequestParamsSchema, body: rejectJoinRequestSchema }),
  joinRequestController.reject,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const requestResponse = envelope(joinRequestResponseSchema)
const myRequestResponse = envelope(myJoinRequestResponseSchema)
const notModerator = errorResponse('Không có quyền duyệt trong tổ chức này')

registry.registerPath({
  method: 'post',
  path: '/join-requests',
  operationId: 'createJoinRequest',
  tags: ['JoinRequest'],
  summary: 'Gửi đơn xin vào một tổ chức',
  description:
    'Không cần thuộc tổ chức nào trước đó. Có trần số đơn đang chờ và cooldown sau khi bị ' +
    'từ chối để hàng đợi của tổ chức không bị rải đơn.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createJoinRequestSchema } } } },
  responses: {
    201: jsonResponse('Đã gửi đơn', myRequestResponse),
    403: errorResponse('Tổ chức đang không nhận đơn'),
    409: errorResponse('Đã là thành viên, đang có đơn chờ, hoặc chưa hết cooldown'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/join-requests/mine',
  operationId: 'myJoinRequests',
  tags: ['JoinRequest'],
  summary: 'Đơn của tôi và trạng thái từng đơn',
  ...protectedRoute,
  responses: { 200: jsonResponse('Danh sách đơn', envelope(z.array(myJoinRequestResponseSchema))) },
})

registry.registerPath({
  method: 'delete',
  path: '/join-requests/{id}',
  operationId: 'cancelJoinRequest',
  tags: ['JoinRequest'],
  summary: 'Rút đơn đang chờ',
  ...protectedRoute,
  request: { params: joinRequestParamsSchema },
  responses: {
    200: jsonResponse('Đã rút đơn', myRequestResponse),
    403: errorResponse('Không phải đơn của bạn'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/join-requests',
  operationId: 'listJoinRequests',
  tags: ['JoinRequest'],
  summary: 'Hàng đợi đơn của tổ chức hiện tại',
  ...protectedRoute,
  request: { query: joinRequestQuerySchema },
  responses: {
    200: jsonResponse('Hàng đợi', envelope(z.array(joinRequestResponseSchema))),
    403: notModerator,
  },
})

registry.registerPath({
  method: 'patch',
  path: '/join-requests/{id}/approve',
  operationId: 'approveJoinRequest',
  tags: ['JoinRequest'],
  summary: 'Duyệt đơn và gán nhóm con ngay trong cùng thao tác',
  description:
    'Gán `unitId` ở đây chứ không tách thành bước riêng: cơ chế request không tự phân nhóm ' +
    'được, tách bước ra thì sẽ không ai làm và lớp duyệt phân tầng mất chỗ dựa.',
  ...protectedRoute,
  request: {
    params: joinRequestParamsSchema,
    body: { content: { 'application/json': { schema: approveJoinRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Đã duyệt', requestResponse),
    403: notModerator,
    409: errorResponse('Đơn đã được xử lý hoặc đã hết hiệu lực'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/join-requests/{id}/reject',
  operationId: 'rejectJoinRequest',
  tags: ['JoinRequest'],
  summary: 'Từ chối đơn',
  ...protectedRoute,
  request: {
    params: joinRequestParamsSchema,
    body: { content: { 'application/json': { schema: rejectJoinRequestSchema } } },
  },
  responses: { 200: jsonResponse('Đã từ chối', requestResponse), 403: notModerator },
})

registry.registerPath({
  method: 'post',
  path: '/join-requests/bulk-approve',
  operationId: 'bulkApproveJoinRequests',
  tags: ['JoinRequest'],
  summary: 'Duyệt hàng loạt, mỗi đơn kèm nhóm con của nó',
  description:
    'Từng đơn hỏng không làm hỏng cả lô — response trả kết quả từng dòng để người duyệt biết ' +
    'đơn nào cần xem lại.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: bulkApproveSchema } } } },
  responses: {
    200: jsonResponse(
      'Kết quả từng đơn',
      envelope(
        z.object({
          approved: z.number(),
          failed: z.number(),
          results: z.array(
            z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() }),
          ),
        }),
      ),
    ),
    403: notModerator,
  },
})

export default router
