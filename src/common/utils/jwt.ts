import jwt, { SignOptions } from 'jsonwebtoken'
import { env } from '../../config/env'

/**
 * Payload chỉ còn `sub`.
 *
 * Bỏ `organizationId`: tài khoản là toàn cục, và org hoạt động do TỪNG REQUEST chỉ ra
 * (subdomain / header `X-Org-Slug`), rồi được đối chiếu với `memberships` ở thời điểm đó.
 * Nhét org vào token nghĩa là quyền truy cập org đóng băng theo hạn token — rời org xong vẫn
 * vào được cho tới khi token hết hạn.
 *
 * Bỏ `role`: quyền hạn nằm ở `role_grants` và được nạp mỗi request, cùng lý do.
 *
 * Bỏ `type`: nhánh platform-admin đã gộp vào user, không còn hai loại token để phân biệt.
 */
export interface JwtPayload {
  sub: string
}

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
