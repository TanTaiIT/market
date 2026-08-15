import { z } from 'zod'
import { Router } from 'express'
import { locationController } from './location.controller'
import { wardQuerySchema, provinceResponseSchema, wardListResponseSchema } from './location.schema'
import { validate } from '../../middlewares/validate.middleware'
import { registry, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Công khai, không cần đăng nhập: đây là từ điển hành chính, không phải dữ liệu của tenant nào.
router.get('/provinces', locationController.provinces)
router.get('/wards', validate({ query: wardQuerySchema }), locationController.wards)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/locations/provinces',
  operationId: 'locationProvinces',
  tags: ['Location'],
  summary: '34 tỉnh/thành sau sáp nhập 01/07/2025',
  description:
    'Danh sách đóng dùng cho ô chọn khu vực. `name` chính là giá trị hợp lệ của ' +
    '`location.province` khi đăng tin và của `?province=` khi lọc — client không được tự chế ' +
    'biến thể có tiền tố "TP." hay "Tỉnh".',
  responses: {
    200: jsonResponse('Danh sách tỉnh/thành', envelope(z.array(provinceResponseSchema))),
  },
})

registry.registerPath({
  method: 'get',
  path: '/locations/wards',
  operationId: 'locationWards',
  tags: ['Location'],
  summary: 'Phường/xã của một tỉnh',
  description:
    'Mô hình 2 cấp: không còn quận/huyện ở giữa. Trả kèm `province` để client cache theo tỉnh ' +
    'mà không phải tự ghép lại khoá.',
  request: { query: wardQuerySchema },
  responses: {
    200: jsonResponse('Danh sách phường/xã', envelope(wardListResponseSchema)),
    400: errorResponse('Tên tỉnh không nằm trong danh sách 34 đơn vị'),
  },
})

export default router
