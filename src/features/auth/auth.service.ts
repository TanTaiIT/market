import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { UnauthorizedError, ConflictError } from '../../common/errors'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../common/utils/jwt'

function issueTokens(user: IUserDocument) {
  const payload = { sub: user._id.toString(), role: user.role }
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  }
}

export const authService = {
  async register(input: RegisterInput): Promise<AuthResult> {
    if (await userRepository.existsByEmail(input.email)) {
      throw new ConflictError('Email already registered')
    }
    const user = await userRepository.create(input)
    return { user, ...issueTokens(user) }
  },

  async login({ email, password }: LoginInput): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email, { withPassword: true })
    if (!user) throw new UnauthorizedError('Invalid email or password')
    if (!user.isActive) throw new UnauthorizedError('Account is disabled')

    const matched = await user.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    await userRepository.updateById(user._id.toString(), { lastLoginAt: new Date() })
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
