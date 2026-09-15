import { z } from 'zod'
import { Router } from 'express'
import { roleGrantController } from './role-grant.controller'
import {
  createRoleGrantSchema,
  roleGrantParamsSchema,
  roleGrantResponseSchema,
} from './role-grant.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Cấp và thu hồi là việc của RIÊNG master (§5.3): hệ thống không còn cấp phó, quản trị nhóm
// không cấp được quyền cho ai. Chốt ở router để câu trả lời rõ ngay từ cửa; `canGrant` bên
// dưới vẫn giữ hai luật còn lại (không cấp master, không tự cấp cho mình).
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: createRoleGrantSchema }),
  roleGrantController.grant,
)
router.get('/mine', authenticate, roleGrantController.mine)
router.delete(
  '/:id',
  authenticate,
  requireMaster,
  validate({ params: roleGrantParamsSchema }),
  roleGrantController.revoke,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const grantResponse = envelope(roleGrantResponseSchema)

registry.registerPath({
  method: 'post',
  path: '/role-grants',
  operationId: 'createRoleGrant',
  tags: ['RoleGrant'],
  summary: 'Cấp quyền cho một người',
  description:
    'CHỈ master. Cấp được `manager` ở phạm vi `org` hoặc (danh mục × tỉnh/phường); vai trò ' +
    '`staff` đã bỏ (400) và không ai cấp được `master` (403). Không ai tự cấp quyền cho ' +
    'chính mình. Người nhận đi bằng `userId` hoặc `userEmail` — đúng một trong hai; người ' +
    'phụ trách trục danh mục thường không thuộc tổ chức nào nên email là đường tự nhiên.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createRoleGrantSchema } } } },
  responses: {
    201: jsonResponse('Đã cấp quyền', grantResponse),
    400: errorResponse('Vai trò staff đã bỏ, hoặc phạm vi không hợp lệ'),
    403: errorResponse('Cần quyền master, hoặc đang cấp master / tự cấp cho mình'),
    404: errorResponse('Chưa có tài khoản nào dùng email đó'),
    409: errorResponse('Người này đã có đúng quyền đó'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/role-grants/mine',
  operationId: 'myRoleGrants',
  tags: ['RoleGrant'],
  summary: 'Quyền hệ thống của chính mình',
  ...protectedRoute,
  responses: { 200: jsonResponse('Danh sách quyền', envelope(z.array(roleGrantResponseSchema))) },
})

registry.registerPath({
  method: 'delete',
  path: '/role-grants/{id}',
  operationId: 'revokeRoleGrant',
  tags: ['RoleGrant'],
  summary: 'Thu hồi một quyền (chỉ master)',
  description:
    'Không thu hồi được master cuối cùng: hệ thống không còn master là hệ thống không ai cấp ' +
    'lại được quyền cho ai.',
  ...protectedRoute,
  request: { params: roleGrantParamsSchema },
  responses: {
    200: jsonResponse('Đã thu hồi', grantResponse),
    403: errorResponse('Không đủ thẩm quyền'),
    409: errorResponse(
      'Phải luôn còn ít nhất một master, và mỗi tổ chức phải luôn còn ít nhất một quản trị',
    ),
  },
})

export default router
