import { z } from 'zod'
import { IUserDocument } from './user.model'
import { publicProfileSchema } from './user.schema'

export type PublicProfileDto = z.infer<typeof publicProfileSchema>

/**
 * GET /users/:id không cần đăng nhập — trả nguyên document sẽ lộ email, phone,
 * isEmailVerified, lastLoginAt của mọi user. Whitelist field thay vì blacklist.
 */
export function toPublicProfileDto(user: IUserDocument): PublicProfileDto {
  return {
    id: user._id.toString(),
    name: user.name,
    avatar: user.avatar,
    ratingAvg: user.ratingAvg,
    ratingCount: user.ratingCount,
    createdAt: user.createdAt.toISOString(),
  }
}
