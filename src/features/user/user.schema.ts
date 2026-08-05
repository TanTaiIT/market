import { z } from 'zod'
import { registry } from '../../config/openapi'

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().min(8).max(15).optional(),
    avatar: z.string().url().optional(),
  })
  .strict()
  .openapi('UpdateProfile')

export const userParamsSchema = z.object({ id: objectId })

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>

registry.register('UpdateProfile', updateProfileSchema)
