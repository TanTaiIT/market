import { IUserDocument } from '../user/user.model'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

export interface AuthResult extends AuthTokens {
  user: IUserDocument
}

export interface AuthUserDto {
  id: string
  name: string
  email: string
  phone?: string
  avatar: string
  role: string
  isEmailVerified: boolean
}

export interface AuthResponseDto {
  user: AuthUserDto
  tokens: AuthTokens
}

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
