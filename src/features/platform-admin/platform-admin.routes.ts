import { Router, Request, Response, NextFunction } from 'express'
import { platformAdminController } from './platform-admin.controller'
import { authenticatePlatformAdmin } from './platform-admin.middleware'
import {
  platformLoginSchema,
  platformLoginResponseSchema,
  organizationParamsSchema,
  assignChainSchema,
  setOrgStatusSchema,
} from './platform-admin.schema'
import { createChainSchema, chainResponseSchema } from '../chain/chain.schema'
import { organizationSummarySchema } from '../organization/organization.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authLimiter } from '../../middlewares/rateLimiter.middleware'
import { PLATFORM_ADMIN_ROLES } from '../../common/constants'
import { ForbiddenError } from '../../common/errors'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

/** support chỉ được đọc; mọi thay đổi cấu trúc chain/org là việc của super_admin. */
const requireSuperAdmin = (req: Request, _res: Response, next: NextFunction) =>
  req.platformAdmin?.role === PLATFORM_ADMIN_ROLES.SUPER_ADMIN
    ? next()
    : next(new ForbiddenError('Chỉ super_admin được thực hiện thao tác này'))

router.post(
  '/auth/login',
  authLimiter,
  validate({ body: platformLoginSchema }),
  platformAdminController.login,
)

router.post(
  '/chains',
  authenticatePlatformAdmin,
  requireSuperAdmin,
  validate({ body: createChainSchema }),
  platformAdminController.createChain,
)

router.patch(
  '/organizations/:organizationId/chain',
  authenticatePlatformAdmin,
  requireSuperAdmin,
  validate({ params: organizationParamsSchema, body: assignChainSchema }),
  platformAdminController.assignChain,
)

router.patch(
  '/organizations/:organizationId/status',
  authenticatePlatformAdmin,
  requireSuperAdmin,
  validate({ params: organizationParamsSchema, body: setOrgStatusSchema }),
  platformAdminController.setOrganizationStatus,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const orgResponse = envelope(organizationSummarySchema)
const notSuperAdmin = errorResponse('Cần quyền super_admin')

registry.registerPath({
  method: 'post',
  path: '/platform-admin/auth/login',
  operationId: 'platformAdminLogin',
  tags: ['PlatformAdmin'],
  summary: 'Đăng nhập bên bán phần mềm (JWT type riêng, không thuộc organization nào)',
  request: { body: { content: { 'application/json': { schema: platformLoginSchema } } } },
  responses: {
    200: jsonResponse('Đăng nhập thành công', envelope(platformLoginResponseSchema)),
    401: errorResponse('Sai thông tin đăng nhập'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/platform-admin/chains',
  operationId: 'platformAdminCreateChain',
  tags: ['PlatformAdmin'],
  summary: 'Tạo chain mới và chỉ định chain owner',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createChainSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo chain', envelope(chainResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notSuperAdmin,
    409: errorResponse('Chain slug đã tồn tại'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/platform-admin/organizations/{organizationId}/chain',
  operationId: 'platformAdminAssignChain',
  tags: ['PlatformAdmin'],
  summary: 'Gán org vào chain, hoặc tách ra độc lập với chainId = null',
  ...protectedRoute,
  request: {
    params: organizationParamsSchema,
    body: { content: { 'application/json': { schema: assignChainSchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', orgResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notSuperAdmin,
    404: errorResponse('Không tìm thấy organization hoặc chain'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/platform-admin/organizations/{organizationId}/status',
  operationId: 'platformAdminSetOrganizationStatus',
  tags: ['PlatformAdmin'],
  summary: 'Khoá/mở organization — có hiệu lực ngay, không đợi access token hết hạn',
  ...protectedRoute,
  request: {
    params: organizationParamsSchema,
    body: { content: { 'application/json': { schema: setOrgStatusSchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', orgResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notSuperAdmin,
    404: errorResponse('Không tìm thấy organization'),
  },
})

export default router
