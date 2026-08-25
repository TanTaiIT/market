import { z } from 'zod'
import { Router } from 'express'
import { organizationController } from './organization.controller'
import {
  organizationLookupSchema,
  organizationLookupQuerySchema,
  organizationAdminQuerySchema,
  organizationParamsSchema,
  orgSlugParamsSchema,
  organizationProfileSchema,
  organizationCardSchema,
  organizationSummarySchema,
  myOrganizationSchema,
  createOrganizationSchema,
  grantOrgAdminSchema,
  joinCodeParamsSchema,
  setOrgStatusSchema,
  updateOrganizationSchema,
  changeOrgSlugSchema,
  slugAvailabilityQuerySchema,
  slugAvailabilitySchema,
} from './organization.schema'
import { validate } from '../../middlewares/validate.middleware'
import { lookupLimiter } from '../../middlewares/rateLimiter.middleware'
import {
  authenticate,
  optionalAuth,
  requireMaster,
  requireOrg,
  requireOrgAdmin,
} from '../../middlewares/auth.middleware'
import {
  registry,
  bearerAuth,
  envelope,
  jsonResponse,
  errorResponse,
  paginationMetaSchema,
} from '../../config/openapi'

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

// Người cầm mã xem thẻ nhóm trước khi bấm xin vào. Công khai như `lookup`, và dùng chung
// rate-limit với nó: dò mã bừa cũng là một kiểu quét.
/*
 * Hồ sơ nhóm CÔNG KHAI, mở theo slug. Không đòi đăng nhập — người ta phải đọc được nhóm
 * trước khi quyết định có xin vào hay không, và bắt đăng nhập để xem là một cánh cửa nữa
 * trước cánh cửa xin vào.
 *
 * `optionalAuth` chứ không `authenticate`: khách chưa đăng nhập vẫn đọc được, còn người đã
 * đăng nhập thì được đọc `req.user` để service trả thêm cờ `joined` — nút hiện đúng "Đã
 * tham gia" thay vì mời họ vào lại. Bỏ hẳn middleware auth thì `req.user` không bao giờ có,
 * và cờ đó vĩnh viễn là `false`.
 */
router.get(
  '/profile/:slug',
  lookupLimiter,
  optionalAuth,
  validate({ params: orgSlugParamsSchema }),
  organizationController.publicProfile,
)

router.get(
  '/by-code/:code',
  lookupLimiter,
  validate({ params: joinCodeParamsSchema }),
  organizationController.byCode,
)

// Cần đăng nhập nhưng KHÔNG cần org scope: chính nó là thứ trả lời "tôi được chọn org nào".
router.get('/mine', authenticate, organizationController.mine)

// Hồ sơ nhóm — đường DUY NHẤT trong feature này mà admin org gọi được, phần còn lại của master.
// Không có id trên path: org đến từ scope, đúng khuôn `org-unit` và `role-grant`. Phải khai
// TRƯỚC các route `/:organizationId` — Express khớp theo thứ tự.
router.post(
  '/current/join-code',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  organizationController.rotateJoinCode,
)
router.patch(
  '/current',
  authenticate,
  requireOrg,
  requireOrgAdmin,
  validate({ body: updateOrganizationSchema }),
  organizationController.update,
)

// ── Vận hành hệ thống (master) ──────────────────────────────────────────────
// Bảng tổ chức toàn hệ thống. KHÔNG có `requireOrg`: master không thuộc org nào, và đây chính
// là endpoint trả lời "tôi được chọn org nào" cho họ — bắt có scope trước là khoá vòng tròn.
router.get(
  '/',
  authenticate,
  requireMaster,
  validate({ query: organizationAdminQuerySchema }),
  organizationController.listAll,
)

// Chỉ master tạo được org (quyết định Q2): không có luồng tự phục vụ, nên cũng không có đường
// "tạo nhóm rồi tự duyệt tin của mình" đi vòng qua trục danh mục.
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: createOrganizationSchema }),
  organizationController.create,
)
// Trao quyền phụ trách. Đứng riêng với `POST /` vì hai việc có nhịp khác nhau — xem service.
router.post(
  '/:organizationId/admin',
  authenticate,
  requireMaster,
  validate({ params: organizationParamsSchema, body: grantOrgAdminSchema }),
  organizationController.grantAdmin,
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
  method: 'patch',
  path: '/organizations/current',
  operationId: 'organizationUpdate',
  tags: ['Organization'],
  summary: 'Sửa hồ sơ tổ chức đang hoạt động (admin của chính tổ chức đó)',
  description:
    'Tổ chức lấy từ header `X-Org-Slug` / subdomain, không nhận id trên đường dẫn. Ảnh phải là ' +
    'đường dẫn `res.cloudinary.com` do client upload thẳng lên; gửi `null` để gỡ ảnh, bỏ trống ' +
    'để giữ nguyên. Đổi `slug` vẫn là việc của master.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: updateOrganizationSchema } } } },
  responses: {
    200: jsonResponse('Đã cập nhật', orgResponse),
    400: errorResponse('Dữ liệu không hợp lệ, hoặc ảnh không phải đường dẫn Cloudinary'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền quản lý tổ chức'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/organizations/current/join-code',
  operationId: 'organizationRotateJoinCode',
  tags: ['Organization'],
  summary: 'Xoay mã nhóm (admin của chính tổ chức đó)',
  description:
    'Mã cũ chết ngay lập tức. Đây là đường cắt khi mã lọt ra ngoài — đổi slug thì làm hỏng mọi ' +
    'link đã phát, còn mã thì sinh ra để đổi được.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Mã mới', orgResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền quản lý tổ chức'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/organizations/by-code/{code}',
  operationId: 'organizationByCode',
  tags: ['Organization'],
  summary: 'Xem thẻ nhóm bằng mã (công khai)',
  description:
    'Đủ để người cầm mã nhận ra đúng nhóm trước khi bấm xin vào. Không trả `id`, `slug` hay ' +
    'chính cái mã — endpoint công khai nên chỉ đưa thứ cần để nhận diện.',
  request: { params: joinCodeParamsSchema },
  responses: {
    200: jsonResponse('Thẻ nhóm', envelope(organizationCardSchema)),
    404: errorResponse('Không tìm thấy nhóm nào với mã này'),
    429: errorResponse('Quá nhiều request'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/organizations',
  operationId: 'listOrganizations',
  tags: ['Organization'],
  summary: 'Bảng tổ chức toàn hệ thống (chỉ master)',
  description:
    'Nguồn của bộ chuyển tổ chức cho MASTER, thay chỗ `/organizations/mine` vốn luôn rỗng với ' +
    'họ: quyền master là grant `system`, không phải membership. Trả cả org đang bị khoá — đó ' +
    'chính là thứ master cần xử lý; lọc bằng `status` nếu chỉ muốn org đang chạy.',
  ...protectedRoute,
  request: { query: organizationAdminQuerySchema },
  responses: {
    200: jsonResponse(
      'Danh sách tổ chức',
      envelope(z.array(organizationSummarySchema), paginationMetaSchema),
    ),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
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
  method: 'post',
  path: '/organizations/{organizationId}/admin',
  operationId: 'organizationGrantAdmin',
  tags: ['Organization'],
  summary: 'Trao quyền phụ trách tổ chức cho một tài khoản',
  description:
    'Ghi cùng lúc hai thứ: thân phận `admin` trong danh bạ và quyền quản trị thật. Org đang ở ' +
    '`pending_admin` sẽ chuyển sang `active` ngay lần trao đầu tiên. Gọi lại với cùng một ' +
    'người là thao tác vô hại.',
  ...protectedRoute,
  request: {
    params: organizationParamsSchema,
    body: { content: { 'application/json': { schema: grantOrgAdminSchema } } },
  },
  responses: {
    200: jsonResponse('Đã trao quyền', orgResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
    404: errorResponse('Không tìm thấy tổ chức, hoặc email chưa có tài khoản'),
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
  path: '/organizations/profile/{slug}',
  operationId: 'organizationPublicProfile',
  tags: ['Organization'],
  summary: 'Hồ sơ nhóm công khai (không cần đăng nhập)',
  description:
    'Chỉ nhóm `isPublic`. Nhóm riêng tư trả 404 — không phân biệt được với slug không tồn ' +
    'tại, nên không quét ra được danh sách nhóm kín. Đăng nhập rồi thì có thêm cờ `joined`.',
  request: { params: orgSlugParamsSchema },
  responses: {
    200: jsonResponse('Hồ sơ nhóm', envelope(organizationProfileSchema)),
    404: errorResponse('Không tìm thấy nhóm công khai nào ở slug này'),
    429: errorResponse('Tra cứu quá nhiều lần'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/organizations/lookup',
  operationId: 'organizationLookup',
  tags: ['Organization'],
  summary: 'Tìm nhóm công khai theo tên hoặc slug',
  description:
    'CHỈ nhóm `isPublic` — nhóm riêng tư không lộ ra ở đây kể cả khi gõ đúng tên, cách vào ' +
    'duy nhất vẫn là mã. Bỏ trống `q` để lấy danh sách gợi ý. Trả DANH SÁCH để người dùng tự ' +
    'xác nhận: chọn nhầm nhóm là tin chạy vào hàng đợi của tổ chức khác.',
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
