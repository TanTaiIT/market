import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { organizationService } from '../organization/organization.service'
import { organizationRepository } from '../organization/organization.repository'
import { RegisterInput, LoginInput } from './auth.schema'
import { AuthResult } from './auth.types'
import { UnauthorizedError } from '../../common/errors'
import { currentScope } from '../../common/tenant/tenantContext'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  TOKEN_TYPE,
} from '../../common/utils/jwt'

function issueTokens(user: IUserDocument) {
  const payload = {
    type: TOKEN_TYPE.USER,
    sub: user._id.toString(),
    organizationId: user.organizationId.toString(),
    role: user.role,
  } as const
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  }
}

/** Org phải được resolveTenant xác định TRƯỚC khi tìm user — xem auth.schema.loginSchema. */
function requireOrganizationId(): string {
  const orgId = currentScope()?.ownOrgId
  if (!orgId) {
    throw new UnauthorizedError('Không xác định được organization: thiếu subdomain hoặc orgSlug')
  }
  return orgId.toString()
}

export const authService = {
  /** Tạo Organization mới + owner của nó trong một transaction (xem organizationService). */
  async register(input: RegisterInput): Promise<AuthResult> {
    const { owner } = await organizationService.registerWithOwner(input)
    return { user: owner, ...issueTokens(owner) }
  },

  async login({ email, password }: LoginInput): Promise<AuthResult> {
    const organizationId = requireOrganizationId()

    const user = await userRepository.findByEmail(email, organizationId, { withPassword: true })
    if (!user) throw new UnauthorizedError('Invalid email or password')
    if (!user.isActive) throw new UnauthorizedError('Account is disabled')

    const matched = await user.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    await userRepository.updateById(user._id.toString(), organizationId, {
      lastLoginAt: new Date(),
    })
    return { user, ...issueTokens(user) }
  },

  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token')
    }
    if (payload.type !== TOKEN_TYPE.USER) throw new UnauthorizedError('Invalid refresh token')

    // Refresh token tự mang org của nó, nên route này không cần subdomain. Nhưng nếu request
    // ĐẾN từ một subdomain thì hai bên phải khớp — không cho đổi tenant bằng refresh.
    const scopedOrgId = currentScope()?.ownOrgId?.toString()
    if (scopedOrgId && scopedOrgId !== payload.organizationId) {
      throw new UnauthorizedError('Refresh token thuộc organization khác')
    }
    // Không có scope thì chưa ai check status org -> check ở đây, suspend phải chặn được refresh.
    if (!(await organizationRepository.findActiveById(payload.organizationId))) {
      throw new UnauthorizedError('Organization đã bị khoá')
    }

    const user = await userRepository.findById(payload.sub, payload.organizationId)
    if (!user || !user.isActive) throw new UnauthorizedError('User no longer valid')

    return { user, ...issueTokens(user) }
  },
}
