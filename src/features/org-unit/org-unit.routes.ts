import { z } from 'zod'
import { Router } from 'express'
import { orgUnitController } from './org-unit.controller'
import {
  createOrgUnitSchema,
  updateOrgUnitSchema,
  orgUnitParamsSchema,
  orgUnitResponseSchema,
} from './org-unit.schema'
import { validate } from '../../middlewares/validate.middleware'
import {
  authenticate,
  requireOrg,
  requireMembership,
  requireOrgAdmin,
} from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Đọc: mọi thành viên (màn duyệt đơn cần danh sách nhóm để gán ngay tại chỗ).
// Ghi: `requireOrgAdmin` — staff duyệt tin được nhưng không được đổi cấu trúc tổ chức.
router.get('/', authenticate, requireOrg, requireMembership, orgUnitController.list)
router.post(
  '/',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ body: createOrgUnitSchema }),
  orgUnitController.create,
)
router.patch(
  '/:id',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ params: orgUnitParamsSchema, body: updateOrgUnitSchema }),
  orgUnitController.update,
)
router.delete(
  '/:id',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ params: orgUnitParamsSchema }),
  orgUnitController.remove,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const unitResponse = envelope(orgUnitResponseSchema)
const notOrgAdmin = errorResponse('Cần quyền quản lý tổ chức')

registry.registerPath({
  method: 'get',
  path: '/org-units',
  operationId: 'listOrgUnits',
  tags: ['OrgUnit'],
  summary: 'Nhóm con của tổ chức hiện tại',
  description: 'Tổ chức phẳng thì trả mảng rỗng — không phải lỗi, chỉ là không có tầng trung gian.',
  ...protectedRoute,
  responses: { 200: jsonResponse('Danh sách nhóm', envelope(z.array(orgUnitResponseSchema))) },
})

registry.registerPath({
  method: 'post',
  path: '/org-units',
  operationId: 'createOrgUnit',
  tags: ['OrgUnit'],
  summary: 'Tạo nhóm con',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createOrgUnitSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo', unitResponse),
    403: notOrgAdmin,
    409: errorResponse('Trùng tên nhóm trong tổ chức'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/org-units/{id}',
  operationId: 'updateOrgUnit',
  tags: ['OrgUnit'],
  summary: 'Đổi tên nhóm hoặc gán người phụ trách',
  ...protectedRoute,
  request: {
    params: orgUnitParamsSchema,
    body: { content: { 'application/json': { schema: updateOrgUnitSchema } } },
  },
  responses: { 200: jsonResponse('Đã cập nhật', unitResponse), 403: notOrgAdmin },
})

registry.registerPath({
  method: 'delete',
  path: '/org-units/{id}',
  operationId: 'deleteOrgUnit',
  tags: ['OrgUnit'],
  summary: 'Xoá mềm một nhóm con',
  ...protectedRoute,
  request: { params: orgUnitParamsSchema },
  responses: { 200: jsonResponse('Đã xoá', unitResponse), 403: notOrgAdmin },
})

export default router
