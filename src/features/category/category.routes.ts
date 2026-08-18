import { z } from 'zod'
import { Router } from 'express'
import { categoryController } from './category.controller'
import {
  categoryQuerySchema,
  categoryParamsSchema,
  categoryResponseSchema,
  createCategorySchema,
  updateCategorySchema,
} from './category.schema'
import categoryTemplateRoutes from '../category-template/category-template.routes'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Đọc: công khai. Ghi: chỉ master — danh mục là từ điển dùng chung toàn hệ thống, không thuộc
// tổ chức nào, nên nó là việc vận hành hệ thống chứ không phải việc của một org.
router.get('/', validate({ query: categoryQuerySchema }), categoryController.list)
router.get('/:id', validate({ params: categoryParamsSchema }), categoryController.getById)

// Template thuộc tính của danh mục. Sub-router chứ không phải một handler ở đây: nó có model,
// service và vòng đời version riêng — xem `features/category-template/`.
//
// Đứng SAU `/:id` vẫn tới được: Express khớp theo thứ tự khai báo, nhưng `.get('/:id')` đòi
// khớp TRỌN path nên `/xxx/template` không rơi vào đó mà đi tiếp xuống đây. Nếu sau này thêm
// một `.get('/:id/*')` phía trên, thứ tự sẽ thành vấn đề thật.
router.use('/:id/template', categoryTemplateRoutes)

router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: createCategorySchema }),
  categoryController.create,
)
router.patch(
  '/:id',
  authenticate,
  requireMaster,
  validate({ params: categoryParamsSchema, body: updateCategorySchema }),
  categoryController.update,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/categories',
  operationId: 'categoryList',
  tags: ['Category'],
  summary: 'Danh sách danh mục',
  description:
    'Từ điển dùng chung toàn hệ thống, không thuộc organization nào. Mặc định chỉ trả danh mục ' +
    'đang bật — dùng `includeInactive=true` khi cần thấy cả danh mục đã ngừng sử dụng.',
  request: { query: categoryQuerySchema },
  responses: {
    200: jsonResponse('Danh sách danh mục', envelope(z.array(categoryResponseSchema))),
    400: errorResponse('Query không hợp lệ'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/categories/{id}',
  operationId: 'categoryGetById',
  tags: ['Category'],
  summary: 'Chi tiết một danh mục',
  request: { params: categoryParamsSchema },
  responses: {
    200: jsonResponse('Chi tiết danh mục', envelope(categoryResponseSchema)),
    404: errorResponse('Không tìm thấy danh mục'),
  },
})

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const categoryResponse = envelope(categoryResponseSchema)
const notMaster = errorResponse('Cần quyền master')

registry.registerPath({
  method: 'post',
  path: '/categories',
  operationId: 'createCategory',
  tags: ['Category'],
  summary: 'Tạo danh mục dùng chung toàn hệ thống (chỉ master)',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createCategorySchema } } } },
  responses: {
    201: jsonResponse('Đã tạo danh mục', categoryResponse),
    403: notMaster,
    409: errorResponse('Slug danh mục đã tồn tại'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/categories/{id}',
  operationId: 'updateCategory',
  tags: ['Category'],
  summary: 'Đổi tên/icon/thứ tự, hoặc bật-tắt một danh mục',
  description:
    'Không có endpoint xoá: gỡ danh mục khỏi lưu thông bằng `isActive: false`, vì tin đã đăng ' +
    'vẫn tham chiếu tới nó.',
  ...protectedRoute,
  request: {
    params: categoryParamsSchema,
    body: { content: { 'application/json': { schema: updateCategorySchema } } },
  },
  responses: {
    200: jsonResponse('Đã cập nhật', categoryResponse),
    403: notMaster,
    404: errorResponse('Không tìm thấy danh mục'),
  },
})

export default router
