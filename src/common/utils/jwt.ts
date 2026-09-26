import jwt, { JsonWebTokenError, SignOptions } from 'jsonwebtoken'
import { env } from '../../config/env'

export type TokenType = 'access' | 'refresh'

/**
 * Payload chỉ còn `sub`.
 *
 * Bỏ `organizationId`: tài khoản là toàn cục, và org hoạt động do TỪNG REQUEST chỉ ra
 * (header `X-Org-Id`), rồi được đối chiếu với `memberships` ở thời điểm đó.
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
   * Loại token, ghi từ lúc phát. Token phát trước khi có trường này không mang nó — nên `verify*`
   * còn dựa vào `ver` (chỉ refresh token có) để phân biệt, không bắt buộc `typ`.
   */
  typ?: TokenType
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
  return jwt.sign({ ...payload, typ: 'access' }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as SignOptions)
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions)
}

/**
 * Access token KHÔNG được là refresh token đội lốt.
 *
 * Hai secret khác nhau là chốt thứ nhất, nhưng nó chỉ đúng khi cấu hình đúng — file example từng
 * để hai giá trị giống hệt. Chốt thứ hai không phụ thuộc cấu hình: refresh token mang `ver` (và
 * `typ` từ nay), access thì không. Lọt qua đây là một refresh token bị lộ thành vé vào cửa sống
 * 14 ngày thay vì 15 phút.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload
  if (payload.typ === 'refresh' || payload.ver !== undefined) {
    throw new JsonWebTokenError('refresh token used as access token')
  }
  return payload
}

/**
 * Chiều ngược cũng chặn: access token (không `ver`) đi qua cửa refresh sẽ khớp `tokenVersion` 0
 * của mọi tài khoản chưa từng đăng xuất, vì `auth.service` so `payload.ver ?? 0`.
 */
export function verifyRefreshToken(token: string): JwtPayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload
  if (payload.typ === 'access' || typeof payload.ver !== 'number') {
    throw new JsonWebTokenError('access token used as refresh token')
  }
  return payload
}
