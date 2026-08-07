import { platformAdminRepository } from './platform-admin.repository'
import { PlatformLoginInput } from './platform-admin.schema'
import { chainService } from '../chain/chain.service'
import { CreateChainInput } from '../chain/chain.schema'
import { organizationService } from '../organization/organization.service'
import { toOrganizationDto } from '../organization/organization.types'
import { UnauthorizedError } from '../../common/errors'
import { signAccessToken, TOKEN_TYPE } from '../../common/utils/jwt'
import { logger } from '../../config/logger'
import { TenantStatus } from '../../common/constants'

/** Mọi hành động của bên bán phần mềm lên dữ liệu khách hàng đều để lại dấu vết. */
function audit(adminId: string, action: string, target: Record<string, unknown>) {
  logger.info(`platform-admin ${action}`, { adminId, ...target })
}

export const platformAdminService = {
  async login({ email, password }: PlatformLoginInput) {
    const admin = await platformAdminRepository.findByEmail(email)
    if (!admin) throw new UnauthorizedError('Invalid email or password')

    const matched = await admin.comparePassword(password)
    if (!matched) throw new UnauthorizedError('Invalid email or password')

    return {
      admin,
      accessToken: signAccessToken({
        type: TOKEN_TYPE.PLATFORM_ADMIN,
        sub: admin._id.toString(),
        role: admin.role,
      }),
    }
  },

  async createChain(adminId: string, input: CreateChainInput) {
    const chain = await chainService.create(input)
    audit(adminId, 'create-chain', { chainId: chain._id.toString(), slug: chain.slug })
    return chain
  },

  async assignChain(adminId: string, organizationId: string, chainId: string | null) {
    const org = await organizationService.setChain(organizationId, chainId)
    audit(adminId, 'assign-chain', { organizationId, chainId })
    return toOrganizationDto(org)
  },

  async setOrganizationStatus(adminId: string, organizationId: string, status: TenantStatus) {
    const org = await organizationService.setStatus(organizationId, status)
    audit(adminId, 'set-organization-status', { organizationId, status })
    return toOrganizationDto(org)
  },
}
