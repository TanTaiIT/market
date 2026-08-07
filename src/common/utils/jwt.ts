import jwt, { SignOptions } from 'jsonwebtoken'
import { env } from '../../config/env'
import { OrgRole, PlatformAdminRole } from '../constants'

export const TOKEN_TYPE = {
  USER: 'user',
  PLATFORM_ADMIN: 'platform_admin',
} as const
export type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE]

export interface UserJwtPayload {
  type: typeof TOKEN_TYPE.USER
  sub: string
  organizationId: string
  role: OrgRole
}

export interface PlatformAdminJwtPayload {
  type: typeof TOKEN_TYPE.PLATFORM_ADMIN
  sub: string
  role: PlatformAdminRole
}

/**
 * `type` là ranh giới cứng giữa hai hệ thống auth: token platform-admin không bao giờ
 * được đi qua `authenticate` của user và ngược lại, dù cùng ký bằng một secret.
 */
export type JwtPayload = UserJwtPayload | PlatformAdminJwtPayload

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions)
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions)
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload
}
