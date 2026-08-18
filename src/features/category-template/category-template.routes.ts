import { Router } from 'express'
import { categoryTemplateController } from './category-template.controller'
import {
  templateParamsSchema,
  templateQuerySchema,
  templateResponseSchema,
} from './category-template.schema'
import { validate } from '../../middlewares/validate.middleware'
import { registry, envelope, jsonResponse, errorResponse } from '../../config/openapi'

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
