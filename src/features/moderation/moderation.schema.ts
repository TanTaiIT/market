import { z } from 'zod'
import { registry } from '../../config/openapi'
import {
  AUDIT_ACTION,
  LISTING_STATUS,
  MODERATABLE_STATUSES,
  VN_PROVINCE_NAMES,
} from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const modListingQuerySchema = z.object({
  status: z.enum(MODERATABLE_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const rerouteListingSchema = z
  .object({
    categoryId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/)
      .optional(),
    provinceCode: z.enum(VN_PROVINCE_NAMES).optional(),
  })
  .strict()
  .refine((v) => v.categoryId || v.provinceCode, 'Cần ít nhất một trong categoryId/provinceCode')
  .openapi('RerouteListing')

export const coverageSchema = z
  .object({
    totalCells: z.number(),
    uncovered: z.number(),
    backlog: z.number(),
    cells: z.array(
      z.object({
        categoryId: z.string(),
        categoryName: z.string(),
        provinceCode: z.string(),
        hasModerator: z.boolean(),
        pending: z.number(),
      }),
    ),
  })
  .openapi('CoverageMatrix')

export const modParamsSchema = z.object({ id: objectId })

export const activityQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const setListingStatusSchema = z
  .object({
    status: z.enum([LISTING_STATUS.ACTIVE, LISTING_STATUS.REJECTED, LISTING_STATUS.HIDDEN]),
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  // Từ chối mà không nói lý do thì người đăng không biết sửa gì — chặn ở schema thay vì
  // để service phải nhớ.
  .refine((v) => v.status !== LISTING_STATUS.REJECTED || !!v.reason, {
    message: 'Từ chối tin bắt buộc kèm lý do',
    path: ['reason'],
  })
  .openapi('SetListingStatus')

export const auditEventSchema = z
  .object({
    id: objectId,
    actorName: z.string(),
    action: z.nativeEnum(AUDIT_ACTION),
    summary: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi('AuditEvent')

export const overviewResponseSchema = z
  .object({
    pending: z.number(),
    live: z.number(),
    hidden: z.number(),
    rejected: z.number(),
    users: z.number(),
    openReports: z.number(),
    trend: z.array(z.object({ day: z.string(), approved: z.number(), pending: z.number() })),
    categories: z.array(z.object({ categoryId: objectId, name: z.string(), count: z.number() })),
  })
  .openapi('ModerationOverview')

export type ModListingQuery = z.infer<typeof modListingQuerySchema>
export type ActivityQuery = z.infer<typeof activityQuerySchema>
export type SetListingStatusInput = z.infer<typeof setListingStatusSchema>

registry.register('SetListingStatus', setListingStatusSchema)
registry.register('RerouteListing', rerouteListingSchema)
registry.register('CoverageMatrix', coverageSchema)
registry.register('AuditEvent', auditEventSchema)
registry.register('ModerationOverview', overviewResponseSchema)
