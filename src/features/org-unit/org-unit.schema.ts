import { z } from 'zod'
import { registry } from '../../config/openapi'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const orgUnitParamsSchema = z.object({ id: objectId })

export const createOrgUnitSchema = z
  .object({
    name: z.string().min(1).max(100).openapi({ example: '10A1' }),
    moderatorId: objectId.nullable().optional(),
    parentUnitId: objectId.nullable().optional(),
  })
  .strict()
  .openapi('CreateOrgUnit')

export const updateOrgUnitSchema = createOrgUnitSchema.partial().openapi('UpdateOrgUnit')

export const orgUnitResponseSchema = z
  .object({
    id: objectId,
    name: z.string(),
    moderatorId: objectId.nullable(),
    parentUnitId: objectId.nullable(),
  })
  .openapi('OrgUnit')

export type CreateOrgUnitInput = z.infer<typeof createOrgUnitSchema>
export type UpdateOrgUnitInput = z.infer<typeof updateOrgUnitSchema>

registry.register('CreateOrgUnit', createOrgUnitSchema)
registry.register('UpdateOrgUnit', updateOrgUnitSchema)
registry.register('OrgUnit', orgUnitResponseSchema)
