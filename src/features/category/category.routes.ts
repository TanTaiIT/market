import { z } from 'zod'
import { Router } from 'express'
import { categoryController } from './category.controller'
import {
  categoryQuerySchema,
  categoryParamsSchema,
  categoryResponseSchema,
} from './category.schema'
import { validate } from '../../middlewares/validate.middleware'
import { registry, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Chỉ đọc. Ghi nằm ở `/platform-admin/categories` — xem ghi chú trong category.controller.ts.
router.get('/', validate({ query: categoryQuerySchema }), categoryController.list)
router.get('/:id', validate({ params: categoryParamsSchema }), categoryController.getById)

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

export default router
