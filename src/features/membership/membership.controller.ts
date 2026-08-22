import { membershipService } from './membership.service'
import { canModerateAnyInOrg } from '../../common/authz/policy'
import { roleGrantService } from '../role-grant/role-grant.service'
import { currentScope } from '../../common/tenant/tenantContext'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const membershipController = {
  // GET /memberships
  list: catchAsync(async (req, res) => {
    const orgId = currentScope()?.ownOrgId?.toString() ?? ''
    // Tự nạp grant: route chỉ gác bằng `requireMembership`, mà middleware đó không đọc quyền —
    // `req.grants` chỉ có sẵn ở những route đi qua `requireOrgModerator`/`requireOrgAdmin`.
    // Dựa vào `req.grants ?? []` là mọi quản trị đều bị hạ xuống bản rút gọn mà không báo gì.
    const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
    const detailed = canModerateAnyInOrg(grants, orgId)
    const { items, meta } = await membershipService.list(req.query as never, detailed)
    success(res, { message: 'Members', data: items, meta })
  }),
}
