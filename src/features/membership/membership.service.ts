import { membershipRepository } from './membership.repository'
import { MembershipQuery } from './membership.schema'
import { toMemberDto } from './membership.types'
import { userRepository } from '../user/user.repository'
import { trustRepository } from '../trust/trust.repository'
import { requireOwnOrgId } from '../../common/tenant/tenantContext'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'

export const membershipService = {
  /**
   * Danh bạ thành viên của org đang hoạt động.
   *
   * `organizationId` lấy từ tenant scope chứ không nhận qua tham số: `Membership` đứng ngoài
   * `tenantPlugin` (mt§1.3) nên không có ai chèn filter hộ nó, và scope là nguồn duy nhất đã
   * được `resolveTenant` đối chiếu với chính bảng này.
   *
   * Một lượt đọc `users` cho cả trang thay vì `populate`: populate sang collection không có
   * plugin là lách cách ly (mt§2.3), còn đọc theo đúng danh sách id của org mình thì không.
   */
  async list(query: MembershipQuery, detailed: boolean) {
    const organizationId = requireOwnOrgId('membership.list')
    const pagination = parsePagination(query)
    const { items, total } = await membershipRepository.paginateByOrganization(
      organizationId,
      pagination,
    )

    const userIds = items.map((m) => m.userId)
    // Không phải quản trị thì không đọc uy tín — một lượt truy vấn bỏ hẳn, không phải lọc bỏ
    // sau khi đã lấy về.
    const [users, trustLevels] = await Promise.all([
      userRepository.findByIds(userIds),
      detailed ? trustRepository.levelsOf(userIds) : Promise.resolve(null),
    ])
    const byId = new Map(users.map((u) => [u._id.toString(), u]))

    return {
      items: items.map((m) =>
        toMemberDto(
          m,
          byId.get(m.userId.toString()),
          trustLevels ? (trustLevels.get(m.userId.toString()) ?? 0) : undefined,
        ),
      ),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },
}
