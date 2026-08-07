import { z } from 'zod'
import { registry } from '../../config/openapi'
import { organizationSlugSchema } from '../organization/organization.schema'

// Đăng ký = tạo Organization mới + owner đầu tiên của nó. Không có luồng "đăng ký vào
// org sẵn có" vì cơ chế mời thành viên chưa được chốt — xem docs/architecture/multi-tenant.md.
export const registerSchema = z
  .object({
    organizationName: z.string().min(1).max(150).openapi({ example: 'Trường Hùng Vương' }),
    organizationSlug: organizationSlugSchema.optional().openapi({ example: 'hung-vuong' }),
    name: z.string().min(1, 'Name is required').max(100).openapi({ example: 'Nguyễn Văn A' }),
    email: z.string().email().openapi({ example: 'owner@example.com' }),
    phone: z.string().min(8).max(15).optional().openapi({ example: '0901234567' }),
    password: z.string().min(6, 'Password must be at least 6 characters').max(72),
  })
  .strict()
  .openapi('RegisterInput')

// `email` chỉ unique trong phạm vi (organizationId, email) nên email + password KHÔNG đủ
// để xác định user. Org đến từ subdomain; `orgSlug` là fallback cho dev/demo chưa có
// subdomain và được resolveTenant đọc trước khi vào route này.
export const loginSchema = z
  .object({
    orgSlug: organizationSlugSchema.optional(),
    email: z.string().email(),
    password: z.string().min(1, 'Password is required'),
  })
  .strict()
  .openapi('LoginInput')

export const refreshSchema = z
  .object({ refreshToken: z.string().min(1) })
  .strict()
  .openapi('RefreshInput')

// SoT của response auth: auth.types.ts derive type từ đây thay vì khai báo interface song song.
export const authResponseSchema = z
  .object({
    user: z.object({
      id: z.string(),
      organizationId: z.string(),
      name: z.string(),
      email: z.string().email(),
      phone: z.string().optional(),
      avatar: z.string(),
      role: z.string(),
      isEmailVerified: z.boolean(),
    }),
    tokens: z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
    }),
  })
  .openapi('AuthResponse')

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>

registry.register('RegisterInput', registerSchema)
registry.register('LoginInput', loginSchema)
registry.register('RefreshInput', refreshSchema)
registry.register('AuthResponse', authResponseSchema)
