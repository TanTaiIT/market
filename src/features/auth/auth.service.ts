import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { ConflictError, UnauthorizedError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'
import { logger } from '../../config/logger'

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
