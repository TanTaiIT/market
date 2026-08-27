import { z } from 'zod'
import { Router } from 'express'
import { roleGrantController } from './role-grant.controller'
import {
  createRoleGrantSchema,
  roleGrantParamsSchema,
  roleGrantResponseSchema,
} from './role-grant.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Không có middleware `requireMaster` ở đây: master cấp manager, còn manager cấp staff TRONG
// scope của mình (§5.3). Ai được cấp gì cho ai là câu hỏi của tầng policy, không phải của
// router — nhét vào router thì manager mất đường chia tải và mọi thứ dồn về master.
router.post('/', authenticate, validate({ body: createRoleGrantSchema }), roleGrantController.grant)
router.get('/mine', authenticate, roleGrantController.mine)
router.delete(
  '/:id',
  authenticate,
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
    'Master cấp được `manager` (cả hai loại scope) và `staff`. Manager chỉ cấp được `staff` ' +
    'trong đúng scope của mình. Không ai tự cấp quyền cho chính mình. Người nhận đi bằng ' +
    '`userId` (chọn từ danh bạ) hoặc `userEmail` — đúng một trong hai; người phụ trách trục ' +
    'danh mục không thuộc tổ chức nào nên không có danh bạ nào tra ra `userId`.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createRoleGrantSchema } } } },
  responses: {
    201: jsonResponse('Đã cấp quyền', grantResponse),
    403: errorResponse('Không đủ thẩm quyền để cấp quyền này'),
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
  summary: 'Thu hồi một quyền',
  description:
    'Không thu hồi được master cuối cùng: hệ thống không còn master là hệ thống không ai cấp ' +
    'lại được quyền cho ai.',
  ...protectedRoute,
  request: { params: roleGrantParamsSchema },
  responses: {
    200: jsonResponse('Đã thu hồi', grantResponse),
    403: errorResponse('Không đủ thẩm quyền'),
    409: errorResponse('Phải luôn còn ít nhất một master'),
  },
})

export default router
