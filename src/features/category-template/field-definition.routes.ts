import { z } from 'zod'
import { Router } from 'express'
import { categoryTemplateController } from './category-template.controller'
import { createFieldDefinitionSchema, fieldDefinitionSchema } from './category-template.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

/**
 * Từ điển field dùng chung toàn hệ thống, mount ở `/field-definitions`.
 *
 * Đứng riêng khỏi `/categories/:id/template` vì nó KHÔNG thuộc danh mục nào: `brand` ở Điện
 * thoại và `brand` ở Xe cộ phải là cùng một khoá, nếu không thì bộ lọc `?attrs=` vỡ thành
 * nhiều mảnh không gộp lại được.
 */
const router = Router()

// Đọc cần đăng nhập master: đây là màn dựng template, không phải dữ liệu người mua cần.
router.get('/', authenticate, requireMaster, categoryTemplateController.listDefinitions)
router.post(
  '/',
  authenticate,
  requireMaster,
  validate({ body: createFieldDefinitionSchema }),
  categoryTemplateController.createDefinition,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const notMaster = errorResponse('Cần quyền master')

registry.registerPath({
  method: 'get',
  path: '/field-definitions',
  operationId: 'fieldDefinitionList',
  tags: ['Category'],
  summary: 'Từ điển field dùng chung',
  description: 'Nguồn để master chọn field khi dựng template cho một danh mục.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Từ điển field', envelope(z.array(fieldDefinitionSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
  },
})

registry.registerPath({
  method: 'post',
  path: '/field-definitions',
  operationId: 'fieldDefinitionCreate',
  tags: ['Category'],
  summary: 'Thêm một field mới vào từ điển',
  description:
    '`key` là camelCase ASCII và **không bao giờ đổi được** sau khi có tin dùng nó — nó là khoá ' +
    'trong `Listing.attributes`. Thường không cần gọi trực tiếp: khai `define` ngay trong ' +
    'template thì hệ thống tự thêm vào đây.',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createFieldDefinitionSchema } } } },
  responses: {
    201: jsonResponse('Đã thêm', envelope(fieldDefinitionSchema)),
    400: errorResponse('Dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: notMaster,
    409: errorResponse('Key đã có trong từ điển'),
  },
})

export default router
