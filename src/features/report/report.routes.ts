import { z } from 'zod'
import { Router } from 'express'
import { reportController } from './report.controller'
import {
  createReportSchema,
  reportQuerySchema,
  reportParamsSchema,
  resolveReportSchema,
  reportResponseSchema,
} from './report.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireOrg, requireOrgModerator } from '../../middlewares/auth.middleware'
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

// Gửi báo cáo: mọi thành viên. Đọc và xử: chỉ quản trị — hàng đợi báo cáo lộ ra ai tố ai.
router.post(
  '/',
  authenticate,
  apiLimiter,
  validate({ body: createReportSchema }),
  reportController.create,
)
router.get(
  '/',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ query: reportQuerySchema }),
  reportController.list,
)
router.patch(
  '/:id',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ params: reportParamsSchema, body: resolveReportSchema }),
  reportController.resolve,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const reportResponse = envelope(reportResponseSchema)
const unauthorized = errorResponse('Thiếu hoặc sai access token')
const notModerator = errorResponse('Cần quyền owner hoặc moderator')

registry.registerPath({
  method: 'post',
  path: '/reports',
  operationId: 'reportCreate',
  tags: ['Report'],
  summary: 'Báo cáo một tin đăng hoặc một người dùng',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createReportSchema } } } },
  responses: {
    201: jsonResponse('Đã gửi báo cáo', reportResponse),
    400: errorResponse('Nội dung quá ngắn, hoặc tự báo cáo chính mình'),
    401: unauthorized,
    404: errorResponse('Không tìm thấy đối tượng bị báo cáo'),
    409: errorResponse('Bạn đã báo cáo đối tượng này rồi'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/reports',
  operationId: 'reportList',
  tags: ['Report'],
  summary: 'Hàng đợi báo cáo (quản trị)',
  description: '`count` là số người cùng báo cáo một đối tượng, tính lúc đọc.',
  ...protectedRoute,
  request: { query: reportQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách báo cáo',
      envelope(z.array(reportResponseSchema), paginationMetaSchema),
    ),
    401: unauthorized,
    403: notModerator,
  },
})

registry.registerPath({
  method: 'patch',
  path: '/reports/{id}',
  operationId: 'reportResolve',
  tags: ['Report'],
  summary: 'Đóng báo cáo — gỡ tin bị nhắm tới, hoặc bỏ qua',
  description:
    'Đóng luôn mọi báo cáo còn mở về cùng đối tượng: một tin bị ba người báo cáo thì xử một ' +
    'lần là xong cả ba.',
  ...protectedRoute,
  request: {
    params: reportParamsSchema,
    body: { content: { 'application/json': { schema: resolveReportSchema } } },
  },
  responses: {
    200: jsonResponse('Đã xử lý', reportResponse),
    400: errorResponse('Báo cáo này đã được xử lý rồi'),
    401: unauthorized,
    403: notModerator,
    404: errorResponse('Không tìm thấy báo cáo'),
  },
})

export default router
