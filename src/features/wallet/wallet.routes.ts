import { z } from 'zod'
import { Router } from 'express'
import { walletController } from './wallet.controller'
import {
  adjustWalletSchema,
  walletHistoryQuerySchema,
  walletSchema,
  walletUserParamsSchema,
  xuTransactionSchema,
} from './wallet.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

// Ví là của CHÍNH CHỦ — không có đường cho ai xem ví người khác, kể cả admin org. Master
// cộng/trừ được nhưng cũng không có endpoint đọc ví người khác: cần điều tra thì đọc sổ cái.
router.get('/', authenticate, walletController.me)
router.get(
  '/transactions',
  authenticate,
  validate({ query: walletHistoryQuerySchema }),
  walletController.history,
)

router.post(
  '/:userId/adjust',
  authenticate,
  requireMaster,
  validate({ params: walletUserParamsSchema, body: adjustWalletSchema }),
  walletController.adjust,
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }

registry.registerPath({
  method: 'get',
  path: '/wallet',
  operationId: 'walletGet',
  tags: ['Wallet'],
  summary: 'Số dư Xu của tôi',
  description: 'Ví chưa từng phát sinh giao dịch trả về `0` — không phải 404.',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Số dư', envelope(walletSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/wallet/transactions',
  operationId: 'walletHistory',
  tags: ['Wallet'],
  summary: 'Lịch sử biến động ví',
  description:
    'Sổ cái của chính chủ, mới nhất trước. `balanceAfter` là số dư ngay sau dòng đó — dùng nó ' +
    'để đối chiếu thay vì cộng dồn ở client.',
  ...protectedRoute,
  request: { query: walletHistoryQuerySchema },
  responses: {
    200: jsonResponse('Lịch sử ví', envelope(z.array(xuTransactionSchema))),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'post',
  path: '/wallet/{userId}/adjust',
  operationId: 'walletAdjust',
  tags: ['Wallet'],
  summary: 'Cộng / trừ Xu tay (master)',
  description:
    'Tặng Xu, bồi thường, thu hồi Xu cấp nhầm. `amount` âm là trừ. `note` bắt buộc — dòng sổ ' +
    'do người tạo ra mà không nói vì sao thì tháng sau không ai giải thích được cho khách. ' +
    '`idempotencyKey` do client sinh mỗi lần mở form: bấm nhầm hai lần chỉ ra một dòng sổ.',
  ...protectedRoute,
  request: {
    params: walletUserParamsSchema,
    body: { content: { 'application/json': { schema: adjustWalletSchema } } },
  },
  responses: {
    200: jsonResponse('Đã ghi sổ', envelope(xuTransactionSchema)),
    400: errorResponse('Số Xu phải là số nguyên khác 0'),
    401: errorResponse('Thiếu hoặc sai access token'),
    402: errorResponse('Trừ quá số dư đang có'),
    403: errorResponse('Cần quyền master'),
    404: errorResponse('Không tìm thấy người dùng'),
  },
})

export default router
