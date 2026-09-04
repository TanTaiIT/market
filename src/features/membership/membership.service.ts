import { membershipRepository } from './membership.repository'
import { MembershipQuery } from './membership.schema'
import { toMemberDto } from './membership.types'
import { userRepository } from '../user/user.repository'
import { trustRepository } from '../trust/trust.repository'
import { INITIAL_TRUST } from '../trust/trust.policy'
import { roleGrantService } from '../role-grant/role-grant.service'
import { canAdminOrg, isMaster, type Grant } from '../../common/authz/policy'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors'
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
          trustLevels ? (trustLevels.get(m.userId.toString()) ?? INITIAL_TRUST.level) : undefined,
        ),
      ),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Gỡ một người khỏi org đang hoạt động.
   *
   * Hai chốt, và cả hai đều là để nhóm không tự bắn vào chân mình:
   *
   * 1. **Không gỡ chính mình.** Đây là nút của người QUẢN TRỊ dành cho người khác; tự gỡ là
   *    thao tác "rời nhóm", một hành động khác hẳn với hậu quả khác hẳn (mất quyền quản trị
   *    ngay lập tức) nên nó phải có đường riêng, không núp dưới nút này.
   * 2. **Không gỡ người đang giữ quyền quản trị org**, trừ khi mình là master. Thiếu chốt này
   *    thì hai quản trị gỡ lẫn nhau — ai bấm trước thắng, và nhóm có thể còn lại con số không
   *    người phụ trách. Master đứng ngoài vì họ là đường sửa sai cuối cùng.
   */
  async remove(targetUserId: string, actor: { id: string; grants: Grant[] }) {
    const organizationId = requireOwnOrgId('membership.remove')

    if (targetUserId === actor.id) {
      throw new BadRequestError('Không tự gỡ mình khỏi nhóm ở đây — dùng chức năng rời nhóm')
    }

    if (!isMaster(actor.grants)) {
      const targetGrants = await roleGrantService.grantsOf(targetUserId)
      if (canAdminOrg(targetGrants, organizationId.toString())) {
        throw new ForbiddenError('Người này cũng là quản trị nhóm — cần master để gỡ')
      }
    }

    const removed = await membershipRepository.archiveOne(targetUserId, organizationId)
    if (!removed) throw new NotFoundError('Người này không còn trong nhóm')
    return removed
  },
}
