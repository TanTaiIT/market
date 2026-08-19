import { Router } from 'express'
import { membershipController } from './membership.controller'
import { membershipQuerySchema, memberResponseSchema } from './membership.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireOrg, requireOrgModerator } from '../../middlewares/auth.middleware'
import { z } from 'zod'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

const router = Router()

// Bàn quản trị, không phải màn hình của thành viên thường: danh bạ này tồn tại để gán nhóm con
// và cấp quyền. Mở rộng cho mọi thành viên là một quyết định riêng, không kèm theo cái này.
router.get(
  '/',
  authenticate,
  requireOrg,
  requireOrgModerator,
  validate({ query: membershipQuerySchema }),
  membershipController.list,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/memberships',
  operationId: 'membershipList',
  tags: ['Membership'],
  summary: 'Danh bạ thành viên của tổ chức đang hoạt động',
  description:
    'Nguồn DUY NHẤT của danh sách thành viên. Trước khi có endpoint này client phải suy ra ' +
    'roster từ đơn gia nhập đã duyệt, và cách đó bỏ sót đúng những người không đi qua đơn: ' +
    'chủ tổ chức do master chỉ định, và người được thêm thẳng vào roster.',
  security: [{ [bearerAuth.name]: [] }],
  request: { query: membershipQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh bạ thành viên',
      envelope(z.array(memberResponseSchema), paginationMetaSchema),
    ),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền owner hoặc moderator của tổ chức'),
  },
})

export default router
