import { z } from 'zod'
import { registry } from '../../config/openapi'
import {
  organizationSlugSchema,
  organizationSummarySchema,
} from '../organization/organization.schema'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const chainParamsSchema = z.object({ chainId: objectId })

export const createChainSchema = z
  .object({
    name: z.string().min(1).max(150).openapi({ example: 'Hệ thống Trường ABC' }),
    slug: organizationSlugSchema.optional().openapi({ example: 'abc-edu' }),
    ownerId: objectId.openapi({ description: 'User được chỉ định làm chain owner' }),
  })
  .strict()
  .openapi('CreateChain')

export const chainResponseSchema = z
  .object({
    _id: objectId,
    name: z.string(),
    slug: z.string(),
    ownerId: objectId,
    status: z.string(),
    createdAt: z.string().datetime(),
  })
  .passthrough()
  .openapi('Chain')

export const chainStatsSchema = z
  .object({
    chainId: objectId,
    totals: z.object({
      organizations: z.number(),
      listings: z.number(),
      users: z.number(),
    }),
    breakdown: z.array(
      z.object({
        organization: organizationSummarySchema,
        listings: z.number(),
        users: z.number(),
      }),
    ),
  })
  .openapi('ChainStats')

export type CreateChainInput = z.infer<typeof createChainSchema>

registry.register('CreateChain', createChainSchema)
registry.register('Chain', chainResponseSchema)
registry.register('ChainStats', chainStatsSchema)
