import { z } from 'zod'
import { Router } from 'express'
import { organizationController } from './organization.controller'
import {
  organizationLookupSchema,
  organizationLookupQuerySchema,
  organizationParamsSchema,
  organizationSummarySchema,
  myOrganizationSchema,
  createOrganizationSchema,
  setOrgStatusSchema,
  changeOrgSlugSchema,
  slugAvailabilityQuerySchema,
  slugAvailabilitySchema,
} from './organization.schema'
import { validate } from '../../middlewares/validate.middleware'
import { lookupLimiter } from '../../middlewares/rateLimiter.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Hai route CÔNG KHAI, cố tình không đòi đăng nhập: người dùng phải chọn được org TRƯỚC khi
// có bất kỳ quan hệ nào với nó (gửi request tham gia, hoặc gửi tin từ ngoài vào).
// Chốt duy nhất ở đây là rate limit — xem `lookupLimiter`.
router.get(
  '/lookup',
  lookupLimiter,
  validate({ query: organizationLookupQuerySchema }),
  organizationController.lookup,
)

router.get(
  '/slug-availability',
  lookupLimiter,
  validate({ query: slugAvailabilityQuerySchema }),
  organizationController.slugAvailability,
)

// Cần đăng nhập nhưng KHÔNG cần org scope: chính nó là thứ trả lời "tôi được chọn org nào".
router.get('/mine', authenticate, organizationController.mine)

// ── Vận hành hệ thống (master) ──────────────────────────────────────────────
// Chỉ master tạo được org (quyết định Q2): không có luồng tự phục vụ, nên cũng không có đường
// "tạo nhóm rồi tự duyệt tin của mình" đi vòng qua trục danh mục.
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: createOrganizationSchema }),
  organizationController.create,
)
router.patch(
  '/:organizationId/status',
  authenticate,
  requireMaster,
  validate({ params: organizationParamsSchema, body: setOrgStatusSchema }),
  organizationController.setStatus,
)
router.patch(
  '/:organizationId/slug',
  authenticate,
  requireMaster,
  validate({ params: organizationParamsSchema, body: changeOrgSlugSchema }),
  organizationController.changeSlug,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const orgResponse = envelope(organizationSummarySchema)
const notMaster = errorResponse('Cần quyền master')

registry.registerPath({
  method: 'get',
  path: '/organizations/mine',
  operationId: 'myOrganizations',
  tags: ['Organization'],
  summary: 'Các tổ chức tôi đang là thành viên',
  description:
    'Nguồn của bộ chuyển tổ chức phía client: org hoạt động do client chỉ ra bằng header ' +
    '`X-Org-Slug`, nên client phải biết mình được phép gửi những slug nào.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Danh sách tổ chức', envelope(z.array(myOrganizationSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/organizations',
  operationId: 'createOrganization',
  tags: ['Organization'],
  summary: 'Tạo tổ chức và chỉ định người chủ (chỉ master)',
  description:
    'Tạo đồng thời ba thứ: bản ghi tổ chức, quan hệ thành viên `owner`, và quyền `manager` ' +
    'scope org cho người chủ. Người chủ phải có tài khoản trước.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createOrganizationSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo tổ chức', orgResponse),
    403: notMaster,
    404: errorResponse('Không tìm thấy tài khoản của người chủ'),
    409: errorResponse('Slug đã tồn tại hoặc bị cấm'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/organizations/{organizationId}/status',
  operationId: 'setOrganizationStatus',
  tags: ['Organization'],
  summary: 'Khoá/mở tổ chức — có hiệu lực ngay, không đợi token hết hạn',
  ...protectedRoute,
  request: {
    params: organizationParamsSchema,
    body: { content: { 'application/json': { schema: setOrgStatusSchema } } },
  },
  responses: { 200: jsonResponse('Đã cập nhật', orgResponse), 403: notMaster },
})

registry.registerPath({
  method: 'patch',
  path: '/organizations/{organizationId}/slug',
  operationId: 'changeOrganizationSlug',
  tags: ['Organization'],
  summary: 'Đổi slug, slug cũ tự thành alias redirect 301',
  ...protectedRoute,
  request: {
    params: organizationParamsSchema,
    body: { content: { 'application/json': { schema: changeOrgSlugSchema } } },
  },
  responses: {
    200: jsonResponse('Đã đổi slug', orgResponse),
    403: notMaster,
    409: errorResponse('Slug mới đã tồn tại hoặc bị cấm'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/organizations/lookup',
  operationId: 'organizationLookup',
  tags: ['Organization'],
  summary: 'Dropdown chọn tổ chức theo tên hoặc slug',
  description:
    'Trả DANH SÁCH để người dùng tự xác nhận. Client không được tự lấy phần tử đầu tiên khi ' +
    'có nhiều kết quả: chọn nhầm org là tin chạy vào hàng đợi của tổ chức khác.',
  request: { query: organizationLookupQuerySchema },
  responses: {
    200: jsonResponse('Danh sách tổ chức khớp', envelope(z.array(organizationLookupSchema))),
    429: errorResponse('Tra cứu quá nhiều lần'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/organizations/slug-availability',
  operationId: 'organizationSlugAvailability',
  tags: ['Organization'],
  summary: 'Kiểm tra slug còn dùng được không (kèm gợi ý hậu tố)',
  description:
    'Chỉ trả available + gợi ý. KHÔNG trả tên tổ chức đang giữ slug đó — trả tên là biến ' +
    'endpoint công khai này thành công cụ liệt kê khách hàng.',
  request: { query: slugAvailabilityQuerySchema },
  responses: {
    200: jsonResponse('Kết quả kiểm tra', envelope(slugAvailabilitySchema)),
    429: errorResponse('Tra cứu quá nhiều lần'),
  },
})

export default router
