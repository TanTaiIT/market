import { z } from 'zod'
import { registry } from '../../config/openapi'

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
    chainId: z.string().nullable(),
    status: z.string(),
  })
  .openapi('Organization')

export type OrganizationSummaryDto = z.infer<typeof organizationSummarySchema>

registry.register('Organization', organizationSummarySchema)
