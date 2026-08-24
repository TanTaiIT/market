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

/**
 * Dựng tài khoản master qua HTTP. `setupToken` phải khớp `env.MASTER_SETUP_TOKEN` — xem
 * `authService.bootstrapMaster` cho lý do nó thay chỗ của `Authorization`.
 */
export const bootstrapMasterSchema = z
  .object({
    setupToken: z.string().min(32).openapi({ example: '<MASTER_SETUP_TOKEN của môi trường>' }),
    email: z.string().email().openapi({ example: 'tai.nguyen@ahasoft.vn' }),
    password: z.string().min(6).max(72),
    name: z.string().min(1).max(100).optional().openapi({ example: 'Tai Nguyen' }),
  })
  .strict()
  .openapi('BootstrapMasterInput')

/** Cố tình KHÔNG trả token đăng nhập: dựng xong thì đi qua `POST /auth/login` như mọi người. */
export const bootstrapMasterResponseSchema = z
  .object({
    userId: z.string(),
    email: z.string().email(),
    created: z.boolean().openapi({ description: 'false = tài khoản đã có, chỉ đặt lại mật khẩu' }),
    granted: z.boolean().openapi({ description: 'false = đã có quyền master từ trước' }),
    totalMasters: z.number(),
  })
  .openapi('BootstrapMasterResult')

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
export type BootstrapMasterInput = z.infer<typeof bootstrapMasterSchema>

registry.register('RegisterInput', registerSchema)
registry.register('LoginInput', loginSchema)
registry.register('RefreshInput', refreshSchema)
registry.register('AuthResponse', authResponseSchema)
registry.register('BootstrapMasterInput', bootstrapMasterSchema)
registry.register('BootstrapMasterResult', bootstrapMasterResponseSchema)
