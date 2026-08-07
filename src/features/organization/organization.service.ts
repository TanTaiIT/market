import mongoose, { Types } from 'mongoose'
import { organizationRepository, clearOrganizationCache } from './organization.repository'
import { IOrganizationDocument } from './organization.model'
import { userRepository } from '../user/user.repository'
import { IUserDocument } from '../user/user.model'
import { chainRepository } from '../chain/chain.repository'
import { ORG_ROLES, TenantStatus } from '../../common/constants'
import { ConflictError, NotFoundError } from '../../common/errors'
import { slugify } from '../../common/utils/slugify'

export interface RegisterOrganizationInput {
  organizationName: string
  organizationSlug?: string
  name: string
  email: string
  phone?: string
  password: string
}

export const organizationService = {
  /**
   * Vòng lặp phụ thuộc: Organization.ownerId cần User, User.organizationId cần Organization.
   * Giải bằng cách sinh `_id` trước ở phía app + transaction, KHÔNG bằng cách cho field
   * nullable rồi update 2 bước — cách đó để lại cửa sổ tồn tại org không chủ.
   *
   * Cần replica set (docker-compose đã chuyển sang `--replSet rs0`).
   */
  async registerWithOwner(input: RegisterOrganizationInput) {
    const slug = slugify(input.organizationSlug ?? input.organizationName)
    if (await organizationRepository.existsBySlug(slug)) {
      throw new ConflictError(`Organization slug "${slug}" đã tồn tại`)
    }

    const orgId = new Types.ObjectId()
    const userId = new Types.ObjectId()

    let owner!: IUserDocument
    let organization!: IOrganizationDocument

    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        owner = await userRepository.create(
          {
            _id: userId,
            organizationId: orgId,
            role: ORG_ROLES.OWNER,
            name: input.name,
            email: input.email,
            phone: input.phone,
            password: input.password,
          },
          session,
        )
        const [org] = await organizationRepository.create(
          { _id: orgId, ownerId: userId, chainId: null, name: input.organizationName, slug },
          session,
        )
        organization = org
      })
    } finally {
      await session.endSession()
    }

    clearOrganizationCache()
    return { organization, owner }
  },

  async getById(id: string) {
    const org = await organizationRepository.findById(id)
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },

  /** Gán/gỡ org khỏi chain. `chainId = null` = tách ra độc lập, data nghiệp vụ không đổi (§6.3). */
  async setChain(organizationId: string, chainId: string | null) {
    if (chainId && !(await chainRepository.findActiveById(chainId))) {
      throw new NotFoundError('Chain not found or suspended')
    }
    const org = await organizationRepository.updateById(organizationId, {
      chainId: chainId ? new Types.ObjectId(chainId) : null,
    })
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },

  async setStatus(organizationId: string, status: TenantStatus) {
    const org = await organizationRepository.updateById(organizationId, { status })
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },
}
