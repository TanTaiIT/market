import { z } from 'zod'
import { IUserDocument } from './user.model'
import { meProfileSchema, publicProfileSchema } from './user.schema'

export type PublicProfileDto = z.infer<typeof publicProfileSchema>
export type MeProfileDto = z.infer<typeof meProfileSchema>

/**
 * GET /users/:id không cần đăng nhập — trả nguyên document sẽ lộ email, phone,
 * isEmailVerified, lastLoginAt của mọi user. Whitelist field thay vì blacklist.
 */
export function toPublicProfileDto(user: IUserDocument): PublicProfileDto {
  return {
    id: user._id.toString(),
    name: user.name,
    avatar: user.avatar,
    gender: user.gender,
    ratingAvg: user.ratingAvg,
    ratingCount: user.ratingCount,
    createdAt: user.createdAt.toISOString(),
  }
}

/**
 * GET/PATCH /users/me. Cùng lý do whitelist như trên, cộng một lý do nữa: trả nguyên document
 * khiến response im lặng đổi hình mỗi lần model đổi, và client chỉ biết lúc nó nổ ở runtime.
 *
 * `isEmailVerified` dẫn xuất từ `emailVerifiedAt` — giống hệt `toAuthResponseDto`, để "user
 * hiện tại" chỉ có MỘT hình dạng dù đến từ lúc đăng nhập hay lúc mở lại app.
 */
export function toMeProfileDto(user: IUserDocument): MeProfileDto {
  return {
    ...toPublicProfileDto(user),
    email: user.email,
    phone: user.phone,
    location: user.location,
    showPhone: user.showPhone,
    isEmailVerified: Boolean(user.emailVerifiedAt),
    isActive: user.isActive,
  }
}
