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

/**
 * Trước đây schema này `passthrough` và controller trả nguyên document. Hệ quả: khi model bỏ
 * cột `role`, schema vẫn khai `role: z.string()`, SDK sinh ra `role: string`, và app gọi
 * `profile.role.trim()` trên `undefined`. Không có gì bắt được vì chẳng ai đối chiếu hai bên.
 *
 * Nên giờ nó là whitelist đi qua `toMeProfileDto` — đúng cách `publicProfileSchema` đã làm.
 * Vai trò KHÔNG nằm ở đây: nó là quan hệ (`memberships.role`, `role_grants.role`), đọc qua
 * `/organizations/mine` và `/role-grants/mine`.
 */
export const meProfileSchema = publicProfileSchema
  .extend({
    email: z.string().email(),
    phone: z.string().optional(),
    isEmailVerified: z.boolean(),
    isActive: z.boolean(),
  })
  .openapi('MeProfile')

export const userParamsSchema = z.object({ id: objectId })

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>

registry.register('UpdateProfile', updateProfileSchema)
registry.register('PublicProfile', publicProfileSchema)
registry.register('MeProfile', meProfileSchema)
