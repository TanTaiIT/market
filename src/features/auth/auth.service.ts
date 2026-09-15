import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { ConflictError, UnauthorizedError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'
import { logger } from '../../config/logger'
import { verifyGoogleIdToken } from './google.verify'

function issueTokens(user: IUserDocument) {
  const sub = user._id.toString()
  return {
    accessToken: signAccessToken({ sub }),
    // Chỉ refresh token mang `ver` — xem `JwtPayload.ver` về việc vì sao access thì không.
    refreshToken: signRefreshToken({ sub, ver: user.tokenVersion }),
  }
}

export const authService = {
  /**
   * Đăng ký = tạo TÀI KHOẢN, không tạo tổ chức.
   *
   * Chỉ master tạo được org (quyết định Q2), và người đăng tin ở trục danh mục không thuộc org
   * nào cả — bắt chọn org ở bước đăng ký là chặn chết nguyên một trục. Muốn vào một org thì
   * gửi request tham gia từ trang profile (`POST /join-requests`).
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    if (await userRepository.existsByEmail(input.email)) {
      throw new ConflictError('Email đã được đăng ký')
    }

    const user = await userRepository.create({
      name: input.name,
      email: input.email,
      phone: input.phone,
      password: input.password,
    })
    return { user, ...issueTokens(user) }
  },

  /**
   * Đăng nhập / đăng ký bằng Google — MỘT đường cho cả hai, vì client không biết trước tài khoản
   * đã tồn tại chưa và không nên biết (hỏi trước là dựng ra một endpoint dò email).
   *
   * Ba nhánh, theo đúng thứ tự này:
   *
   * 1. **Khớp `googleId`** → đăng nhập. Khớp theo `sub` TRƯỚC email vì `sub` không đổi khi người
   *    dùng đổi địa chỉ Gmail; khớp email trước là tạo tài khoản thứ hai cho cùng một người.
   * 2. **Khớp email** → LIÊN KẾT, và rút mật khẩu cũ.
   * 3. Không khớp gì → tạo tài khoản mới, không mật khẩu.
   *
   * ── Vì sao nhánh 2 phải rút mật khẩu ──
   *
   * Đây là chốt chống "chiếm tài khoản trước" (pre-hijacking): kẻ tấn công đăng ký
   * `nan-nhan@gmail.com` bằng mật khẩu TRƯỚC khi chủ hộp thư kịp dùng Google. Nếu ta liên kết mà
   * giữ mật khẩu, chủ thật đăng nhập Google vào đúng tài khoản của kẻ tấn công — và kẻ đó vẫn
   * còn mật khẩu, tức vẫn đọc được tin nhắn lẫn tin đăng của họ mãi về sau.
   *
   * Rút mật khẩu giải quyết dứt điểm vì nó xếp lại thứ tự bằng chứng: một lượt đăng nhập Google
   * chứng minh người này ĐANG kiểm soát hộp thư; một mật khẩu chỉ chứng minh ai đó từng gõ một
   * chuỗi. Ở hệ này vế thứ hai còn yếu hơn bình thường — KHÔNG có luồng xác thực email nào, nên
   * `emailVerifiedAt` của mọi tài khoản mật khẩu đều là `null`.
   *
   * Không ai bị khoá ra ngoài: hộp thư vẫn là hộp thư đó nên cửa Google luôn mở. Họ mất một cửa,
   * không mất tài khoản. Đổi lại `$inc tokenVersion` cắt mọi phiên đang mở ở máy khác.
   */
  async withGoogle(idToken: string): Promise<AuthResult> {
    const identity = await verifyGoogleIdToken(idToken)

    const linked = await userRepository.findByGoogleId(identity.googleId)
    if (linked) {
      if (!linked.isActive) throw new UnauthorizedError('Account is disabled')
      await userRepository.updateById(linked._id, { lastLoginAt: new Date() })
      return { user: linked, ...issueTokens(linked) }
    }

    const sameEmail = await userRepository.findByEmail(identity.email)
    if (sameEmail) {
      /*
       * Chặn TRƯỚC khi liên kết, không phải sau: một tài khoản bị khoá mà liên kết được thì
       * `$inc tokenVersion` vẫn chạy và mật khẩu vẫn bị rút — tức lệnh khoá của quản trị lại
       * thành đường đổi chủ tài khoản.
       */
      if (!sameEmail.isActive) throw new UnauthorizedError('Account is disabled')

      const user = await userRepository.linkGoogle(sameEmail._id, identity.googleId)
      if (!user) throw new UnauthorizedError('Không liên kết được tài khoản Google')

      logger.info('google account linked, password retired', { userId: user._id.toString() })
      await userRepository.updateById(user._id, { lastLoginAt: new Date() })
      return { user, ...issueTokens(user) }
    }

    /*
     * Tài khoản mới: KHÔNG có `password`, và `emailVerifiedAt` đặt luôn — Google vừa chứng minh
     * hộp thư. `avatar` nhận ảnh Google: đó là URL của Google chứ không phải Cloudinary, nên nó
     * KHÔNG đi qua đường kiểm duyệt ảnh và cũng không bị job dọn ảnh mồ côi nhặt.
     */
    const created = await userRepository.create({
      name: identity.name,
      email: identity.email,
      googleId: identity.googleId,
      avatar: identity.picture,
      emailVerifiedAt: new Date(),
    })
    logger.info('google account created', { userId: created._id.toString() })
    return { user: created, ...issueTokens(created) }
  },

  /** Đăng nhập toàn cục: email unique toàn hệ thống nên không cần biết org. */
  async login({ email, password }: LoginInput): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email, { withPassword: true })
    if (!user) throw new UnauthorizedError('Invalid email or password')
    if (!user.isActive) throw new UnauthorizedError('Account is disabled')

    const matched = await user.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    await userRepository.updateById(user._id, { lastLoginAt: new Date() })
    return { user, ...issueTokens(user) }
  },

  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token')
    }

    const user = await userRepository.findById(payload.sub)
    if (!user || !user.isActive) throw new UnauthorizedError('User no longer valid')

    /*
     * Token phát trước lần đăng xuất gần nhất thì chết ở đây.
     *
     * `?? 0` cho token cũ phát trước khi có trường này — chúng không mang `ver`, và tài
     * khoản chưa từng đăng xuất cũng đang ở 0, nên hai bên khớp. Không ai bị đá ra lúc deploy.
     */
    if ((payload.ver ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedError('Phiên đã kết thúc — đăng nhập lại')
    }

    return { user, ...issueTokens(user) }
  },

  /**
   * Đăng xuất — cắt MỌI phiên của tài khoản này, trên mọi thiết bị.
   *
   * Với refresh token stateless thì chỉ có đúng hai hành vi khả dĩ: không cắt được gì, hoặc
   * cắt sạch. Cắt sạch là lựa chọn đúng cho ca người ta thật sự cần tới nút này — nghi bị lộ
   * tài khoản, hoặc vừa mất điện thoại. Muốn đăng xuất TỪNG THIẾT BỊ thì phải có bảng
   * `refresh_tokens` với `jti` (và khi đó mới phát hiện được tái dùng token) — một việc
   * khác, lớn hơn hẳn, chưa cần tới ở quy mô này.
   *
   * Access token đang cầm vẫn sống tối đa 15 phút nữa: đó là cái giá đã biết của việc không
   * đọc DB ở mọi request. Cửa sổ đó chấp nhận được; 30 ngày thì không.
   */
  async logout(userId: string): Promise<void> {
    await userRepository.bumpTokenVersion(userId)
    logger.info('auth: đăng xuất mọi thiết bị', { userId })
  },
}
