import { z } from 'zod'
import { Router } from 'express'
import { chainController } from './chain.controller'
import { chainParamsSchema, chainStatsSchema } from './chain.schema'
import { requireChainOwner } from './chain.middleware'
import { createNotificationSchema } from '../notification/notification.schema'
import { organizationSummarySchema } from '../organization/organization.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// KHÔNG có GET /chains/:id/listings: tin đăng cross-org trong chain đã tự động nằm trong
// GET /listings cho mọi user của chain (tenantPlugin + chainReadable), nên route riêng
// chỉ tạo ra hai đường đọc cho cùng một dữ liệu.
router.get(
  '/:chainId/stats',
  authenticate,
  validate({ params: chainParamsSchema }),
  requireChainOwner,
  chainController.stats,
)
router.get(
  '/:chainId/organizations',
  authenticate,
  validate({ params: chainParamsSchema }),
  requireChainOwner,
  chainController.organizations,
)
router.post(
  '/:chainId/notifications',
  authenticate,
  validate({ params: chainParamsSchema, body: createNotificationSchema }),
  requireChainOwner,
  chainController.broadcast,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const notChainOwner = errorResponse('Không phải chủ chain')

registry.registerPath({
  method: 'get',
  path: '/chains/{chainId}/stats',
  operationId: 'chainStats',
  tags: ['Chain'],
  summary: 'Thống kê tổng hợp toàn chain (read-only)',
  ...protectedRoute,
  request: { params: chainParamsSchema },
  responses: {
    200: jsonResponse('Thống kê chain', envelope(chainStatsSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notChainOwner,
  },
})

registry.registerPath({
  method: 'get',
  path: '/chains/{chainId}/organizations',
  operationId: 'chainOrganizations',
  tags: ['Chain'],
  summary: 'Danh sách organization trong chain',
  ...protectedRoute,
  request: { params: chainParamsSchema },
  responses: {
    200: jsonResponse('Danh sách org', envelope(z.array(organizationSummarySchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notChainOwner,
  },
})

registry.registerPath({
  method: 'post',
  path: '/chains/{chainId}/notifications',
  operationId: 'chainBroadcast',
  tags: ['Chain'],
  summary: 'Gửi thông báo tới mọi org trong chain (fan-out mỗi org một bản ghi)',
  ...protectedRoute,
  request: {
    params: chainParamsSchema,
    body: { content: { 'application/json': { schema: createNotificationSchema } } },
  },
  responses: {
    201: jsonResponse('Đã fan-out', envelope(z.object({ organizations: z.number() }))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notChainOwner,
  },
})

export default router
