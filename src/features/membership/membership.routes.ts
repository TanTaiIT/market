import { Router } from 'express'
import { membershipController } from './membership.controller'
import {
  memberParamsSchema,
  membershipQuerySchema,
  memberResponseSchema,
} from './membership.schema'
import { validate } from '../../middlewares/validate.middleware'
import {
  authenticate,
  requireMembershipOrOrgModerator,
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
//
// Người quản org mà KHÔNG phải thành viên (master, manager org) cũng đọc được: họ xoá được
// thành viên ở `DELETE` bên dưới, nên chặn họ đọc danh sách chỉ tạo ra một bàn quản trị
// thao tác được mà không nhìn được.
router.get(
  '/',
  authenticate,
  requireOrg,
  requireMembershipOrOrgModerator,
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
    403: errorResponse('Không phải thành viên, và cũng không có quyền quản tổ chức này'),
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
