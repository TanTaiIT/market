import { Types } from 'mongoose'
import { chainRepository } from './chain.repository'
import { CreateChainInput } from './chain.schema'
import { organizationRepository } from '../organization/organization.repository'
import { toOrganizationDto } from '../organization/organization.types'
import { listingRepository } from '../listing/listing.repository'
import { userRepository } from '../user/user.repository'
import { notificationService } from '../notification/notification.service'
import { CreateNotificationInput } from '../notification/notification.schema'
import { requireScope } from '../../common/tenant/tenantContext'
import { ConflictError, NotFoundError } from '../../common/errors'
import { slugify } from '../../common/utils/slugify'

function countOf(rows: { _id: Types.ObjectId; count: number }[], orgId: Types.ObjectId): number {
  return rows.find((row) => row._id.equals(orgId))?.count ?? 0
}

export const chainService = {
  async create(input: CreateChainInput) {
    const slug = slugify(input.slug ?? input.name)
    if (await chainRepository.existsBySlug(slug)) {
      throw new ConflictError(`Chain slug "${slug}" đã tồn tại`)
    }
    return chainRepository.create({
      name: input.name,
      slug,
      ownerId: new Types.ObjectId(input.ownerId),
    })
  },

  async getById(chainId: string) {
    const chain = await chainRepository.findActiveById(chainId)
    if (!chain) throw new NotFoundError('Chain not found')
    return chain
  },

  async organizations(chainId: string) {
    const orgs = await organizationRepository.listByChain(new Types.ObjectId(chainId))
    return orgs.map(toOrganizationDto)
  },

  /**
   * Thống kê tổng hợp toàn chain. Không có nhánh riêng nào cho chain trong repository —
   * requireChainOwner chỉ mở scope rộng hơn, query bên dưới giữ nguyên.
   */
  async stats(chainId: string) {
    const scope = requireScope('chain.stats')
    const [orgs, listingCounts, userCounts] = await Promise.all([
      organizationRepository.listByChain(new Types.ObjectId(chainId)),
      listingRepository.countByOrganizations(),
      userRepository.countByOrganizations(scope.chainOrgIds),
    ])

    const breakdown = orgs.map((org) => ({
      organization: toOrganizationDto(org),
      listings: countOf(listingCounts, org._id),
      users: countOf(userCounts, org._id),
    }))

    return {
      chainId,
      totals: {
        organizations: orgs.length,
        listings: breakdown.reduce((sum, row) => sum + row.listings, 0),
        users: breakdown.reduce((sum, row) => sum + row.users, 0),
      },
      breakdown,
    }
  },

  /** Thông báo cấp chain: fan-out sang mọi org đang active trong chain (§4.7). */
  async broadcast(chainId: string, input: CreateNotificationInput) {
    const scope = requireScope('chain.broadcast')
    await notificationService.createForChain(new Types.ObjectId(chainId), scope.chainOrgIds, input)
    return { organizations: scope.chainOrgIds.length }
  },
}
