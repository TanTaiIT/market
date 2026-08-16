import { z } from 'zod'
import { registry } from '../../config/openapi'

// Đăng ký chỉ tạo tài khoản: không có `organizationName`, không có `orgSlug`. Người dùng vào
// org sau, bằng request tham gia từ trang profile (§7.1) — tách ra là điều kiện để người đăng
// tin ở trục danh mục dùng được sản phẩm mà không thuộc tổ chức nào.
export const registerSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(100).openapi({ example: 'Nguyễn Văn A' }),
    email: z.string().email().openapi({ example: 'nguyenvana@example.com' }),
    phone: z.string().min(8).max(15).optional().openapi({ example: '0901234567' }),
    password: z.string().min(6, 'Password must be at least 6 characters').max(72),
  })
  .strict()
  .openapi('RegisterInput')

// `email` unique toàn cục trở lại nên email + password đủ để xác định tài khoản.
export const loginSchema = z
  .object({
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
      name: z.string(),
      email: z.string().email(),
      phone: z.string().optional(),
      avatar: z.string(),
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
