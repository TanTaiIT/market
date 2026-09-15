import { catchAsync } from '../../common/utils/catchAsync'
import { ForbiddenError } from '../../common/errors'
import { currentScope, runWithTenant } from '../../common/tenant/tenantContext'
import { canModerateAnyInOrg, isMaster } from '../../common/authz/policy'
import { SCOPE_TYPES } from '../../common/constants'
import { roleGrantService } from '../role-grant/role-grant.service'
import { organizationRepository } from '../organization/organization.repository'
import { requireCategoryModerator } from '../moderation/moderation.middleware'

/**
 * Cửa ĐỌC hàng đợi báo cáo — hai trục trong MỘT danh sách.
 *
 * Báo cáo đóng dấu trục của TIN (xem `report.service.targetOf`), nên "hàng đợi của tôi" là hợp
 * của hai vế: báo cáo trong org tôi đang đứng (nếu tôi duyệt được gì đó ở đó) + báo cáo trục
 * công khai trong ô tôi phụ trách (nếu có). `tenantPlugin` ghép hai vế bằng `$or`; việc ở đây
 * chỉ là dựng scope cho đúng — không có vế nào thì 403, không phải danh sách rỗng.
 *
 * Master: mọi org + cả trục công khai — họ là fallback của mọi ô chưa có người phụ trách, cùng
 * luật với hàng đợi duyệt (`requireCategoryModerator`).
 *
 * Thay `requireOrgReadOrMaster` của bản trước: cửa đó chỉ biết trục org, nên người phụ trách
 * (danh mục × tỉnh) — thường không thuộc org nào — ăn 403 ngay ở cửa, và master thì đọc trục
 * công khai ở `mode: 'approved'`, tức là không thấy báo cáo nào ở đó.
 */
export const requireReportReader = catchAsync(async (req, _res, next) => {
  const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
  req.grants = grants
  const scope = currentScope()!

  if (isMaster(grants)) {
    return runWithTenant(
      {
        ...scope,
        readableOrgIds: await organizationRepository.allActiveIds(),
        publicAxis: { mode: 'moderator', categoryIds: [], cells: null },
      },
      next,
    )
  }

  const orgId = scope.ownOrgId
  const readsOrg = !!orgId && canModerateAnyInOrg(grants, orgId.toString())
  const readsAxis = grants.some(
    (g) =>
      g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE || g.scopeType === SCOPE_TYPES.CATEGORY_WARD,
  )
  if (!readsOrg && !readsAxis) throw new ForbiddenError('Bạn không có quyền xem báo cáo')

  // Vế org: CHỈ org đang đứng, và chỉ khi duyệt được ở đó — `resolveTenant` cho đọc mọi org mình
  // là thành viên, nhưng thành viên thường không phải người duyệt.
  const withOrg = { ...scope, readableOrgIds: readsOrg && orgId ? [orgId] : [] }
  if (!readsAxis) return runWithTenant({ ...withOrg, publicAxis: null }, next)

  // Vế công khai: `requireCategoryModerator` dựng ô từ grant lên trên scope hiện tại — chạy nó
  // BÊN TRONG scope đã sửa vế org, để hai vế cùng nằm trong một scope.
  runWithTenant(withOrg, () => requireCategoryModerator(req, _res, next))
})
