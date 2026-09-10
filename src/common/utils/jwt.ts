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
  /**
   * Phiên bản phiên, CHỈ có trong refresh token.
   *
   * Refresh token là bearer stateless sống 30 ngày: server không lưu gì nên không có gì để
   * xoá, và trước khi có trường này thì một token bị lộ dùng được tới hết hạn — đổi mật khẩu
   * hay đăng xuất đều không cắt được. `user.tokenVersion` là chốt: lệch một nhịp là mọi
   * refresh token đã phát đều chết ngay.
   *
   * KHÔNG đưa vào access token: access chỉ sống 15 phút, mà kiểm `ver` thì phải đọc DB ở
   * MỌI request — đổi một chốt rẻ thành một truy vấn trên đường nóng, để rút ngắn cửa sổ rủi
   * ro từ 15 phút xuống 0. Không đáng.
   */
  ver?: number
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
