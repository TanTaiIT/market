import { Router } from 'express'
import { categoryTemplateController } from './category-template.controller'
import {
  templateParamsSchema,
  templateFieldsSchema,
  templateQuerySchema,
  templateResponseSchema,
  templateVersionParamsSchema,
} from './category-template.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

/**
 * Mount dưới `/categories` (xem `features/index.ts`) — đường dẫn thuộc về danh mục, còn code
 * thì ở lại feature này vì template có vòng đời riêng (version, draft/published) mà
 * `features/category` không mang.
 *
 * `mergeParams` để `:id` của route cha đi xuống tới đây.
 */
const router = Router({ mergeParams: true })

// Đọc công khai, cùng lý do với `GET /categories`: màn tìm kiếm cũng cần template để dựng bộ
// lọc, mà tìm kiếm thì không đòi đăng nhập. Ghi không có endpoint — template do
// `scripts/seed-templates.ts` đặt, xem `listing-template.plan.md` §0.4.
router.get(
  '/',
  validate({ params: templateParamsSchema, query: templateQuerySchema }),
  categoryTemplateController.getForCategory,
)

/*
 * Đường GHI — chỉ master, cùng lý do với `POST /categories`: template quyết định form đăng tin
 * và bộ lọc của cả một danh mục dùng chung toàn hệ thống, không thuộc về org nào.
 *
 * Sửa bản đã phát hành thì tạo bản nháp mới thay vì mutate: tin đăng ghim `templateRef.version`.
 */
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ params: templateParamsSchema, body: templateFieldsSchema }),
  categoryTemplateController.createDraft,
)
router.patch(
  '/:version',
  authenticate,
  requireMaster,
  validate({ params: templateVersionParamsSchema, body: templateFieldsSchema }),
  categoryTemplateController.updateDraft,
)
router.post(
  '/:version/publish',
  authenticate,
  requireMaster,
  validate({ params: templateVersionParamsSchema }),
  categoryTemplateController.publish,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/categories/{id}/template',
  operationId: 'categoryGetTemplate',
  tags: ['Category'],
  summary: 'Template thuộc tính của một danh mục',
  description:
    'Trả về danh sách field ĐÃ GHÉP sẵn giữa template và từ điển `field_definitions` — client ' +
    'không phải gọi vòng hai để tra `label`/`options`. Danh mục chưa có template riêng thì ' +
    'rơi về bản chung, nhận biết bằng `isFallback: true`.\n\n' +
    'Form SỬA TIN truyền `?version=` lấy từ `Listing.templateRef.version` để dựng lại đúng bộ ' +
    'field lúc tin được tạo — không có nó thì tin cũ hiện field của template mới.',
  request: { params: templateParamsSchema, query: templateQuerySchema },
  responses: {
    200: jsonResponse('Template của danh mục', envelope(templateResponseSchema)),
    404: errorResponse('Chưa seed template nào'),
  },
})

export default router

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const notMaster = errorResponse('Cần quyền master')
const templateResponse = jsonResponse('Template', envelope(templateResponseSchema))

registry.registerPath({
  method: 'post',
  path: '/categories/{id}/template',
  operationId: 'categoryTemplateCreateDraft',
  tags: ['Category'],
  summary: 'Tạo bản nháp template cho một danh mục',
  description:
    'Version tự tăng từ bản cao nhất đang có, kể cả bản nháp. Field nào chưa có trong từ điển ' +
    'thì khai `define` ngay trong dòng đó — hệ thống tự thêm vào `/field-definitions`. ' +
    'Tối đa 8 field mở lọc: mỗi field lọc là một nhánh index phải quét trên mọi tin của danh mục.',
  ...protectedRoute,
  request: {
    params: templateParamsSchema,
    body: { content: { 'application/json': { schema: templateFieldsSchema } } },
  },
  responses: {
    201: templateResponse,
    400: errorResponse('Field chưa có trong từ điển, trùng key/order, hoặc quá số field lọc'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
    404: errorResponse('Không tìm thấy danh mục'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/categories/{id}/template/{version}',
  operationId: 'categoryTemplateUpdateDraft',
  tags: ['Category'],
  summary: 'Sửa bản nháp template',
  description:
    'Chỉ sửa được bản `draft`. Bản đã phát hành là bất biến — tin đăng ghim ' +
    '`templateRef.version` và form sửa tin dựng lại đúng bộ field lúc tin ra đời.',
  ...protectedRoute,
  request: {
    params: templateVersionParamsSchema,
    body: { content: { 'application/json': { schema: templateFieldsSchema } } },
  },
  responses: {
    200: templateResponse,
    400: errorResponse('Bản đã phát hành, hoặc template không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
    404: errorResponse('Không tìm thấy template'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/categories/{id}/template/{version}/publish',
  operationId: 'categoryTemplatePublish',
  tags: ['Category'],
  summary: 'Phát hành bản nháp',
  description:
    'Từ lúc này tin mới của danh mục dùng bộ field này. Bản cũ ở lại `published` vĩnh viễn để ' +
    'tin đã đăng còn đọc được. Kiểm lại toàn vẹn một lần nữa tại đây: từ điển có thể đã xoá mềm ' +
    'một field kể từ khi bản nháp được tạo.',
  ...protectedRoute,
  request: { params: templateVersionParamsSchema },
  responses: {
    200: templateResponse,
    400: errorResponse('Bản này đã phát hành rồi, hoặc template không còn hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
    404: errorResponse('Không tìm thấy template'),
  },
})
