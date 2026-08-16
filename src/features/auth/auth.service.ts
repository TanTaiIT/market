import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { ConflictError, UnauthorizedError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'

function issueTokens(user: IUserDocument) {
  const payload = { sub: user._id.toString() }
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
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

    return { user, ...issueTokens(user) }
  },
}
