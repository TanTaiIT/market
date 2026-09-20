import { z } from 'zod'
import { registry } from '../../config/openapi'
import { impersonatesMaster } from '../../common/constants'

// Đăng ký chỉ tạo tài khoản: không có `organizationName`, không có tổ chức nào. Người dùng vào
// org sau, bằng request tham gia từ trang profile (§7.1) — tách ra là điều kiện để người đăng
// tin ở trục danh mục dùng được sản phẩm mà không thuộc tổ chức nào.
export const registerSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Name is required')
      .max(100)
      .refine((n) => !impersonatesMaster(n), 'Tên này hệ thống giữ riêng')
      .openapi({ example: 'Nguyễn Văn A' }),
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

/**
 * Đăng nhập bằng Google — client chỉ gửi `id_token`, KHÔNG gửi email/tên.
 *
 * Cố tình không nhận thêm field nào: email và tên phải đến từ token đã kiểm chữ ký
 * (`google.verify.ts`). Nhận `email` trong body là mở đúng cửa mà việc kiểm token sinh ra để
 * đóng — ai cũng gửi được một email bất kỳ kèm một token thật của chính mình.
 */
export const googleAuthSchema = z
  .object({
    idToken: z.string().min(1, 'Thiếu id_token của Google'),
  })
  .strict()
  .openapi('GoogleAuthInput')

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>

registry.register('RegisterInput', registerSchema)
registry.register('LoginInput', loginSchema)
registry.register('RefreshInput', refreshSchema)
registry.register('GoogleAuthInput', googleAuthSchema)
registry.register('AuthResponse', authResponseSchema)

// ── XÁC THỰC EMAIL BẰNG MÃ 6 SỐ ─────────────────────────────────────────────

export const verifyEmailSchema = z
  .object({
    /**
     * Chuỗi chứ không `number`: mã `012345` là hợp lệ, mà số thì mất số 0 đầu. Regex thay cho
     * `.length(6)` để "12 34 5" hay "12-3456" bị chặn ngay ở cửa thay vì thành một lượt so hash.
     */
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Mã gồm đúng 6 chữ số')
      .openapi({ example: '042913' }),
  })
  .strict()
  .openapi('VerifyEmail')

export const sendCodeResponseSchema = z
  .object({
    expiresInSeconds: z.number(),
    resendAfterSeconds: z.number(),
  })
  .openapi('SendVerificationCode')

// ── QUÊN MẬT KHẨU ───────────────────────────────────────────────────────────

export const forgotPasswordSchema = z
  .object({
    email: z.string().email().openapi({ example: 'nguyenvana@example.com' }),
  })
  .strict()
  .openapi('ForgotPassword')

export const verifyResetCodeSchema = z
  .object({
    email: z.string().email(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Mã gồm đúng 6 chữ số')
      .openapi({ example: '042913' }),
  })
  .strict()
  .openapi('VerifyResetCode')

export const resetTicketSchema = z.object({ resetToken: z.string().min(1) }).openapi('ResetTicket')

export const resetPasswordSchema = z
  .object({
    email: z.string().email(),
    /** Vé nhận ở bước xác minh mã — KHÔNG phải mã 6 số. */
    resetToken: z.string().min(1),
    /**
     * Cùng ràng buộc với `registerSchema.password` — một mật khẩu đặt lại phải qua đúng cửa mà
     * mật khẩu đăng ký đã qua, nếu không thì đây là đường vòng để lách luật độ mạnh.
     */
    password: z.string().min(6).max(72),
  })
  .strict()
  .openapi('ResetPassword')
