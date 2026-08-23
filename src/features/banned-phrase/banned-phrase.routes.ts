import { z } from 'zod'
import { Router } from 'express'
import { bannedPhraseController } from './banned-phrase.controller'
import {
  bannedPhraseParamsSchema,
  bannedPhraseResponseSchema,
  createBannedPhraseSchema,
} from './banned-phrase.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Master-only TOÀN BỘ, kể cả GET — khác `categories`: công bố danh sách cấm là phát cẩm nang
// lách luật cho người đăng ("viết chệch đi một chữ là qua"). Người thường chỉ thấy hệ quả của
// nó qua thông báo từ chối.
router.use(authenticate, requireMaster)

router.get('/', bannedPhraseController.list)
router.post('/', validate({ body: createBannedPhraseSchema }), bannedPhraseController.create)
router.delete('/:id', validate({ params: bannedPhraseParamsSchema }), bannedPhraseController.remove)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'get',
  path: '/banned-phrases',
  operationId: 'bannedPhraseList',
  tags: ['BannedPhrase'],
  summary: 'Danh sách cụm từ cấm (master)',
  description:
    'Từ điển cụm cấm của cổng nội dung — tin chứa cụm nào trong đây bị từ chối ngay lúc đăng, ' +
    'bị chặn lúc sửa, và máy quét từ chối nếu đã nằm sẵn trong hàng đợi. Master-only kể cả đọc: ' +
    'công bố danh sách là chỉ đường lách luật.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Danh sách cụm cấm', envelope(z.array(bannedPhraseResponseSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/banned-phrases',
  operationId: 'bannedPhraseCreate',
  tags: ['BannedPhrase'],
  summary: 'Thêm cụm từ cấm (master)',
  description:
    'Cụm được chuẩn hoá lowercase + trim trước khi lưu. Hiệu lực ngay với tin đăng/sửa mới; ' +
    'tin đang chờ duyệt sẵn trong hàng đợi bị máy quét bắt ở lượt kế tiếp. Nên dùng CỤM ' +
    '(≥2 từ) thay vì từ đơn — từ đơn dễ chém oan ("súng" bắt cả "súng phun nước đồ chơi").',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: createBannedPhraseSchema } } } },
  responses: {
    201: jsonResponse('Đã thêm', envelope(bannedPhraseResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    409: errorResponse('Cụm này đã có trong danh sách'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/banned-phrases/{id}',
  operationId: 'bannedPhraseRemove',
  tags: ['BannedPhrase'],
  summary: 'Gỡ cụm từ cấm (master)',
  ...protectedRoute,
  request: { params: bannedPhraseParamsSchema },
  responses: {
    200: jsonResponse('Đã gỡ', envelope(bannedPhraseResponseSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy cụm cấm'),
  },
})

export default router
