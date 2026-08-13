import { z } from 'zod'
import { registry } from '../../config/openapi'
import { REPORT_KIND, REPORT_STATUS, REPORT_TARGET } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const createReportSchema = z
  .object({
    targetType: z.nativeEnum(REPORT_TARGET),
    targetId: objectId,
    kind: z.nativeEnum(REPORT_KIND),
    quote: z.string().trim().min(10, 'Mô tả rõ hơn giúp quản trị xử nhanh').max(1000),
  })
  .strict()
  .openapi('CreateReport')

export const reportQuerySchema = z.object({
  status: z.nativeEnum(REPORT_STATUS).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const reportParamsSchema = z.object({ id: objectId })

export const resolveReportSchema = z
  .object({
    /** `hide_target` ẩn luôn tin bị báo cáo; `ignore` chỉ đóng báo cáo. */
    action: z.enum(['hide_target', 'ignore']),
  })
  .strict()
  .openapi('ResolveReport')

export const reportResponseSchema = z
  .object({
    id: objectId,
    targetType: z.nativeEnum(REPORT_TARGET),
    targetId: objectId,
    targetTitle: z.string(),
    kind: z.nativeEnum(REPORT_KIND),
    quote: z.string(),
    reporterName: z.string(),
    status: z.nativeEnum(REPORT_STATUS),
    /** Số người cùng báo cáo đối tượng này — tính lúc đọc, không phải counter. */
    count: z.number(),
    createdAt: z.string().datetime(),
  })
  .openapi('Report')

export type CreateReportInput = z.infer<typeof createReportSchema>
export type ReportQuery = z.infer<typeof reportQuerySchema>
export type ResolveReportInput = z.infer<typeof resolveReportSchema>

registry.register('CreateReport', createReportSchema)
registry.register('ResolveReport', resolveReportSchema)
registry.register('Report', reportResponseSchema)
