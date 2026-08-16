import { z } from 'zod'
import { registry } from '../../config/openapi'
import { ORG_TYPES, TENANT_STATUS, VERIFICATION_TIERS } from '../../common/constants'

export const organizationSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug chỉ gồm a-z, 0-9 và dấu gạch ngang')

export const organizationSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    orgType: z.nativeEnum(ORG_TYPES),
    verificationTier: z.nativeEnum(VERIFICATION_TIERS),
    provinceCode: z.string().nullable(),
    status: z.string(),
  })
  .openapi('Organization')

/** Một dòng dropdown — xem `toOrganizationLookupDto` về việc vì sao không có `id`. */
export const organizationLookupSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    district: z.string().nullable(),
    provinceCode: z.string().nullable(),
    allowJoinRequests: z.boolean(),
    allowOutsiderPosts: z.boolean(),
  })
  .openapi('OrganizationLookup')

export const organizationLookupQuerySchema = z.object({
  q: z.string().min(2, 'Cần ít nhất 2 ký tự để tra cứu').max(80),
})

/**
 * Nhánh kiểm tra khả dụng lúc TẠO org: nhận slug thô (chưa chuẩn hoá) vì người dùng đang gõ,
 * service sẽ tự fold. Response chỉ có available + gợi ý, không có tên org nào.
 */
export const slugAvailabilityQuerySchema = z.object({
  slug: z.string().min(1).max(80),
  district: z.string().max(100).optional(),
  provinceCode: z.string().max(60).optional(),
})

export const slugAvailabilitySchema = z
  .object({
    slug: z.string(),
    available: z.boolean(),
    reason: z.enum(['invalid', 'reserved', 'taken']).optional(),
    suggestions: z.array(z.string()).optional(),
  })
  .openapi('SlugAvailability')

export const myOrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    provinceCode: z.string().nullable(),
    role: z.string(),
    unitId: z.string().nullable(),
  })
  .openapi('MyOrganization')

export const organizationParamsSchema = z.object({
  organizationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
})

/**
 * Tạo org — chỉ master. `ownerEmail` chứ không phải `ownerId`: master thao tác theo email của
 * người chủ, và tài khoản đó phải tồn tại trước (đăng ký là việc của chính họ).
 */
export const createOrganizationSchema = z
  .object({
    name: z.string().min(1).max(150).openapi({ example: 'THPT Lý Thường Kiệt' }),
    slug: organizationSlugSchema.optional().openapi({ example: 'thpt-ly-thuong-kiet' }),
    orgType: z.nativeEnum(ORG_TYPES).optional(),
    ownerEmail: z.string().email(),
    provinceCode: z.string().max(60).optional(),
    district: z.string().max(100).optional(),
  })
  .strict()
  .openapi('CreateOrganization')

export const setOrgStatusSchema = z
  .object({ status: z.nativeEnum(TENANT_STATUS) })
  .strict()
  .openapi('SetOrganizationStatus')

export const changeOrgSlugSchema = z
  .object({ slug: organizationSlugSchema })
  .strict()
  .openapi('ChangeOrganizationSlug')

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type OrganizationSummaryDto = z.infer<typeof organizationSummarySchema>
export type OrganizationLookupDto = z.infer<typeof organizationLookupSchema>

registry.register('Organization', organizationSummarySchema)
registry.register('OrganizationLookup', organizationLookupSchema)
registry.register('MyOrganization', myOrganizationSchema)
registry.register('SlugAvailability', slugAvailabilitySchema)
registry.register('CreateOrganization', createOrganizationSchema)
registry.register('SetOrganizationStatus', setOrgStatusSchema)
registry.register('ChangeOrganizationSlug', changeOrgSlugSchema)
