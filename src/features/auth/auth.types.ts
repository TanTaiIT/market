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
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    },
    tokens: { accessToken, refreshToken },
  }
}
