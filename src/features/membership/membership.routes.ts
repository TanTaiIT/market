import { Router } from 'express'
import { membershipController } from './membership.controller'
import { membershipQuerySchema, memberResponseSchema } from './membership.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMembership, requireOrg } from '../../middlewares/auth.middleware'
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

// Thành viên thấy nhau: đây là danh bạ của nhóm, không phải công cụ riêng của bàn quản trị.
// Quản trị nhận thêm ba field hồ sơ vận hành — phân mức nằm ở DTO, không phải ở route.
router.get(
  '/',
  authenticate,
  requireOrg,
  requireMembership,
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
