import { Router } from 'express'
import { metricsController } from './metrics.controller'
import { systemMetricsSchema } from './metrics.schema'
import { authenticate, requireMaster } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

/**
 * Master-only TOÀN BỘ, và đây là chốt duy nhất — không có phiên bản hẹp hơn cho ai khác.
 *
 * Số liệu ở đây gộp mọi tổ chức lại, nên nó là dữ liệu xuyên tenant theo đúng nghĩa: một admin
 * org đọc được nó là đọc được quy mô, nhịp đăng tin và tồn đọng của những nhóm không liên quan
 * gì tới họ. Vì vậy nhánh này KHÔNG dùng `requireOrgReadOrMaster` (vốn cho cả admin org vào)
 * và KHÔNG tái dùng `/moderation/public-overview` (vốn cho manager danh mục vào).
 */
router.use(authenticate, requireMaster)

router.get('/system', metricsController.system)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/metrics/system',
  operationId: 'metricsSystem',
  tags: ['Metrics'],
  summary: 'Tổng quan toàn hệ thống (master)',
  description:
    'Một lượt gọi cho cả bàn tổng quan của master: tổ chức, người dùng, tin đăng theo trục, ' +
    'nhịp 14 ngày, danh mục sôi động, và khối phát hiện tồn đọng (ô chưa có người phụ trách, ' +
    'org không còn manager, tuổi tin chờ lâu nhất). Số đếm chạy NGOÀI trục tenant — xem ghi ' +
    'chú ở `metrics.repository.ts` về việc `requireMaster` không tự mở tenant scope.',
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: jsonResponse('Số liệu toàn hệ thống', envelope(systemMetricsSchema)),
    401: errorResponse('Thiếu hoặc sai access token'),
    403: errorResponse('Cần quyền master'),
  },
})

export default router
