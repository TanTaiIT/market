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
    // Tự nạp grant: cổng `requireMembershipOrOrgModerator` thoát sớm ngay khi có membership,
    // nên với THÀNH VIÊN thì grant vẫn chưa được nạp —
    // `req.grants` chỉ có sẵn ở những route đi qua `requireOrgModerator`/`requireOrgAdmin`.
    // Dựa vào `req.grants ?? []` là mọi quản trị đều bị hạ xuống bản rút gọn mà không báo gì.
    const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
    const detailed = canModerateAnyInOrg(grants, orgId)
    const { items, meta } = await membershipService.list(req.query as never, detailed)
    success(res, { message: 'Members', data: items, meta })
  }),

  // DELETE /memberships/:userId
  remove: catchAsync(async (req, res) => {
    await membershipService.remove(req.params.userId, {
      id: req.user!.id,
      grants: req.grants ?? (await roleGrantService.grantsOf(req.user!.id)),
    })
    success(res, { message: 'Đã gỡ khỏi nhóm', data: null })
  }),
}
