import { z } from 'zod'
import { registry } from '../../config/openapi'

export const registerSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(100).openapi({ example: 'Nguyễn Văn A' }),
    email: z.string().email().openapi({ example: 'user@example.com' }),
    phone: z.string().min(8).max(15).optional().openapi({ example: '0901234567' }),
    password: z.string().min(6, 'Password must be at least 6 characters').max(72),
  })
  .strict()
  .openapi('RegisterInput')

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

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>

registry.register('RegisterInput', registerSchema)
registry.register('LoginInput', loginSchema)
registry.register('RefreshInput', refreshSchema)
