import { OAuth2Client } from 'google-auth-library'
import { env } from '../../config/env'
import { ApiError, UnauthorizedError } from '../../common/errors'
import { httpStatus } from '../../common/constants/httpStatus'

/**
 * Xác minh `id_token` của Google — tầng duy nhất được phép tin một chuỗi do client gửi lên.
 *
 * KHÔNG tự giải JWT rồi đọc `email` trong payload. Một id_token chưa kiểm chữ ký chỉ là chuỗi
 * base64 mà bất kỳ ai cũng soạn được: gõ `{"email":"master@..."}`, base64, gửi lên, và nếu ta
 * tin payload thì đó là đăng nhập-với-danh-nghĩa-người-khác. `verifyIdToken` kiểm chữ ký theo
 * khoá công khai của Google (tự tải và cache JWKS), kiểm `iss`, `exp`, và kiểm `aud` khớp danh
 * sách client ID của MÌNH — vế cuối chặn token thật nhưng do một app Google khác phát ra.
 *
 * Dùng thư viện chính thức thay vì tự ghép `jose` + JWKS: vòng đời khoá của Google (xoay khoá,
 * cache theo `Cache-Control`) là chỗ dễ viết sai mà lỗi chỉ hiện ra vài tuần sau, đúng lúc
 * Google xoay khoá.
 */

/** Cache ở module scope: `OAuth2Client` giữ JWKS đã tải, dựng mới mỗi request là tải lại khoá. */
let client: OAuth2Client | null = null

/**
 * Danh sách audience được phép. Rỗng = tính năng TẮT.
 *
 * Tách khỏi `env` để chuẩn hoá đúng một chỗ: chuỗi env dễ có dấu phẩy thừa hoặc khoảng trắng,
 * và một phần tử rỗng lọt vào danh sách `aud` nghĩa là "chấp nhận token không có audience".
 */
export function allowedAudiences(): string[] {
  return (env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

export interface GoogleIdentity {
  /** `sub` — khoá ổn định, không đổi khi người dùng đổi email. */
  googleId: string
  email: string
  name: string
  /** URL ảnh đại diện, hoặc rỗng khi Google không trả. */
  picture: string
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audience = allowedAudiences()
  if (audience.length === 0) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Đăng nhập bằng Google chưa được bật trên máy chủ này',
    )
  }

  client ??= new OAuth2Client()

  let payload
  try {
    const ticket = await client.verifyIdToken({ idToken, audience })
    payload = ticket.getPayload()
  } catch {
    // Không chuyển tiếp thông điệp của thư viện: nó nói rõ token sai chữ ký / sai audience /
    // hết hạn, và ba thứ đó là bản đồ để dò cấu hình của máy chủ.
    throw new UnauthorizedError('Token Google không hợp lệ hoặc đã hết hạn')
  }

  if (!payload?.sub || !payload.email) {
    throw new UnauthorizedError('Token Google thiếu thông tin tài khoản')
  }

  /*
   * `email_verified` là chốt BẮT BUỘC, không phải thông tin thêm.
   *
   * Google phát id_token cho cả tài khoản mà email chưa xác thực (một số tài khoản Workspace
   * và tài khoản liên kết). Bỏ qua cờ này là để một người đăng ký Google với địa chỉ họ không
   * kiểm soát, rồi dùng nó chiếm tài khoản mật khẩu cùng email ở luật liên kết bên dưới.
   */
  if (!payload.email_verified) {
    throw new UnauthorizedError('Email của tài khoản Google này chưa được xác thực')
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: payload.name?.trim() || payload.email.split('@')[0],
    picture: payload.picture ?? '',
  }
}
