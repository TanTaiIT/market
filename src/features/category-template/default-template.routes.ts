import { z } from 'zod'
import { Router } from 'express'
import { categoryTemplateController } from './category-template.controller'
import {
  defaultTemplateVersionParamsSchema,
  templateFieldsSchema,
  templateQuerySchema,
  templateResponseSchema,
} from './category-template.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

/**
 * MẪU TEMPLATE MẶC ĐỊNH, mount ở `/default-template`.
 *
 * Đứng riêng khỏi `/categories/:id/template` vì nó KHÔNG thuộc danh mục nào: `categoryId` của
 * nó là `null` và `isFallback: true`. Đây là bản mà mọi danh mục chưa có template riêng đang
 * dùng — sửa nó là sửa form đăng tin của tất cả những danh mục đó cùng lúc.
 *
 * Trước file này, bản mặc định chỉ đặt được bằng `scripts/seed-templates.ts`, tức là muốn đổi
 * thì phải vào server chạy script.
 *
 * Master-only kể cả ĐỌC, cùng lý do với `/field-definitions`: đây là bề mặt soạn thảo, không
 * phải dữ liệu người mua cần. Nội dung của bản mặc định thì công khai vẫn đọc được — qua
 * `GET /categories/:id/template` của danh mục đang dùng nó.
 */
const router = Router()

router.get(
  '/',
  authenticate,
  requireMaster,
  validate({ query: templateQuerySchema }),
  categoryTemplateController.getFallback,
)
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: templateFieldsSchema }),
  categoryTemplateController.createFallbackDraft,
)
router.patch(
  '/:version',
  authenticate,
  requireMaster,
  validate({ params: defaultTemplateVersionParamsSchema, body: templateFieldsSchema }),
  categoryTemplateController.updateFallbackDraft,
)
router.post(
  '/:version/publish',
  authenticate,
  requireMaster,
  validate({ params: defaultTemplateVersionParamsSchema }),
  categoryTemplateController.publishFallback,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const notMaster = errorResponse('Cần quyền master')
const noToken = errorResponse('Thiếu hoặc sai access token')
const versionParam = {
  params: z.object({ version: z.coerce.number().int().positive().openapi({ example: 2 }) }),
}

registry.registerPath({
  method: 'get',
  path: '/default-template',
  operationId: 'defaultTemplateGet',
  tags: ['Category'],
  summary: 'Mẫu template mặc định đang phục vụ',
  description:
    'Bản dùng cho mọi danh mục chưa có template riêng. Bỏ trống `version` là lấy bản đã phát ' +
    'hành mới nhất; truyền `version` để đọc một bản nháp đang soạn.',
  ...protectedRoute,
  request: { query: templateQuerySchema },
  responses: {
    200: jsonResponse('Mẫu mặc định', envelope(templateResponseSchema)),
    401: noToken,
    403: notMaster,
  },
})

registry.registerPath({
  method: 'post',
  path: '/default-template',
  operationId: 'defaultTemplateCreateDraft',
  tags: ['Category'],
  summary: 'Tạo bản nháp mới cho mẫu mặc định',
  description:
    'Version kế tiếp của dãy fallback — dãy này RỜI khỏi dãy version của từng danh mục. Bản ' +
    'nháp chưa phục vụ ai cho tới khi phát hành.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: templateFieldsSchema } } } },
  responses: {
    201: jsonResponse('Đã tạo bản nháp', envelope(templateResponseSchema)),
    400: errorResponse('Hình dạng template không hợp lệ'),
    401: noToken,
    403: notMaster,
  },
})

registry.registerPath({
  method: 'patch',
  path: '/default-template/{version}',
  operationId: 'defaultTemplateUpdateDraft',
  tags: ['Category'],
  summary: 'Sửa bản nháp của mẫu mặc định',
  description: 'Chỉ bản `draft`. Bản đã phát hành là bất biến — tạo nháp mới thay vì sửa.',
  ...protectedRoute,
  request: {
    ...versionParam,
    body: { content: { 'application/json': { schema: templateFieldsSchema } } },
  },
  responses: {
    200: jsonResponse('Đã lưu bản nháp', envelope(templateResponseSchema)),
    400: errorResponse('Bản đã phát hành, hoặc hình dạng không hợp lệ'),
    401: noToken,
    403: notMaster,
    404: errorResponse('Không có bản nào ở version này'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/default-template/{version}/publish',
  operationId: 'defaultTemplatePublish',
  tags: ['Category'],
  summary: 'Phát hành bản nháp của mẫu mặc định',
  description:
    'Sau bước này bản đó BẤT BIẾN, và mọi danh mục chưa có template riêng chuyển sang dùng nó ' +
    'ngay. Tin đã đăng vẫn đọc bản version cũ mà chúng ghim.',
  ...protectedRoute,
  request: versionParam,
  responses: {
    200: jsonResponse('Đã phát hành', envelope(templateResponseSchema)),
    400: errorResponse('Bản này đã phát hành rồi'),
    401: noToken,
    403: notMaster,
    404: errorResponse('Không có bản nào ở version này'),
  },
})

export default router
