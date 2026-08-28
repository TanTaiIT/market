import { Router } from 'express'
import { membershipController } from './membership.controller'
import {
  memberParamsSchema,
  membershipQuerySchema,
  memberResponseSchema,
  moveMemberSchema,
} from './membership.schema'
import { validate } from '../../middlewares/validate.middleware'
import {
  authenticate,
  requireMembership,
  requireOrg,
  requireOrgAdmin,
} from '../../middlewares/auth.middleware'
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

/*
 * GHI — quản trị nhóm (`requireOrgAdmin`), không phải người duyệt tin.
 *
 * Gỡ một người khỏi nhóm cắt quyền đọc tin nội bộ của họ ngay lập tức; đó là thao tác về CƠ CẤU
 * tổ chức, cùng hạng với sửa nhóm con — không phải việc của người chỉ được giao duyệt tin.
 */
router.delete(
  '/:userId',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ params: memberParamsSchema }),
  membershipController.remove,
)
router.patch(
  '/:userId',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ params: memberParamsSchema, body: moveMemberSchema }),
  membershipController.move,
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

registry.registerPath({
  method: 'delete',
  path: '/memberships/{userId}',
  operationId: 'membershipRemove',
  tags: ['Membership'],
  summary: 'Gỡ một người khỏi tổ chức (quản trị nhóm)',
  description:
    'Lưu trữ tư cách thành viên chứ không xoá bản ghi — danh bạ cũ là dữ liệu của tổ chức. ' +
    'KHÔNG gỡ được chính mình, và không gỡ được người cũng đang giữ quyền quản trị tổ chức ' +
    '(cần master), nếu không hai quản trị sẽ gỡ lẫn nhau.',
  security: [{ [bearerAuth.name]: [] }],
  request: { params: memberParamsSchema },
  responses: {
    200: jsonResponse('Đã gỡ', envelope(z.null())),
    400: errorResponse('Tự gỡ mình — dùng chức năng rời nhóm'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền quản trị tổ chức, hoặc mục tiêu cũng là quản trị'),
    404: errorResponse('Người này không còn trong nhóm'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/memberships/{userId}',
  operationId: 'membershipMove',
  tags: ['Membership'],
  summary: 'Chuyển thành viên sang nhóm con khác (quản trị nhóm)',
  description:
    'KHÔNG đụng tới quyền: nhóm con chỉ nói người này thuộc lớp/phòng ban nào. Grant phạm vi ' +
    '`org_unit` của họ vẫn trỏ vào nhóm con cũ — đó là việc của màn Phân quyền.',
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: memberParamsSchema,
    body: { content: { 'application/json': { schema: moveMemberSchema } } },
  },
  responses: {
    200: jsonResponse('Đã chuyển', envelope(memberResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền quản trị tổ chức'),
    404: errorResponse('Người này không còn trong nhóm'),
  },
})
