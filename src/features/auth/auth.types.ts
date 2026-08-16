import { z } from 'zod'
import { IUserDocument } from '../user/user.model'
import { authResponseSchema } from './auth.schema'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

export interface AuthResult extends AuthTokens {
  user: IUserDocument
}

export type AuthResponseDto = z.infer<typeof authResponseSchema>

export function toAuthResponseDto(result: AuthResult): AuthResponseDto {
  const { user, accessToken, refreshToken } = result
  return {
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar,
      // Boolean dẫn xuất từ `emailVerifiedAt` chứ không phải cột thứ hai: hai cột cho cùng một
      // sự thật là hai cột sẽ lệch nhau.
      isEmailVerified: Boolean(user.emailVerifiedAt),
    },
    tokens: { accessToken, refreshToken },
  }
}
