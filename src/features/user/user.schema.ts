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

// SoT của public profile: user.types.ts derive type từ đây. Cố tình KHÔNG có
// email/phone/isEmailVerified/lastLoginAt vì GET /users/:id không cần đăng nhập.
export const publicProfileSchema = z
  .object({
    id: objectId,
    name: z.string(),
    avatar: z.string(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    createdAt: z.string().datetime(),
  })
  .openapi('PublicProfile')

// /users/me trả nguyên document (đã bỏ password qua toJSON) — passthrough vì model
// còn field khác và ta không muốn doc phải sửa theo mỗi lần model đổi.
export const meProfileSchema = publicProfileSchema
  .extend({
    email: z.string().email(),
    phone: z.string().optional(),
    role: z.string(),
    isEmailVerified: z.boolean(),
    isActive: z.boolean(),
  })
  .passthrough()
  .openapi('MeProfile')

export const userParamsSchema = z.object({ id: objectId })

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>

registry.register('UpdateProfile', updateProfileSchema)
registry.register('PublicProfile', publicProfileSchema)
registry.register('MeProfile', meProfileSchema)
