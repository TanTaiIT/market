import { Types } from 'mongoose'
import { catchAsync } from '../../common/utils/catchAsync'
import { ForbiddenError } from '../../common/errors'
import { currentScope, runWithTenant } from '../../common/tenant/tenantContext'
import { isMaster } from '../../common/authz/policy'
import { roleGrantService } from '../role-grant/role-grant.service'
import { SCOPE_TYPES } from '../../common/constants'

/**
 * Mở scope đọc của TRỤC DANH MỤC theo đúng ô mà người này được cấp.
 *
 * Phạm vi nằm trong scope chứ không nằm trong query của controller: "manager danh mục không
 * thấy tin ngoài tỉnh" phải là điều kiện `WHERE` bắt buộc ở tầng dưới, không phải một bộ lọc
 * mà một endpoint mới nào đó có thể quên (§5.4).
 */
export const requireCategoryModerator = catchAsync(async (req, _res, next) => {
  const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
  req.grants = grants

  // Master thấy toàn bộ trục công khai: chính họ là fallback của mọi ô chưa có người phụ trách.
  if (isMaster(grants)) {
    return runWithTenant(
      { ...currentScope()!, publicAxis: { mode: 'moderator', categoryIds: [], cells: null } },
      next,
    )
  }

  const axisGrants = grants.filter(
    (g) =>
      g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE || g.scopeType === SCOPE_TYPES.CATEGORY_WARD,
  )
  if (axisGrants.length === 0) throw new ForbiddenError('Bạn không phụ trách danh mục nào')

  const categoryIds = [...new Set(axisGrants.map((g) => g.categoryId!))].map(
    (id) => new Types.ObjectId(id),
  )

  /*
   * Gộp hai tầng thành danh sách ô đọc được.
   *
   * Grant cấp tỉnh phủ cả tỉnh nên nó THẮNG mọi grant phường cùng tỉnh — giữ thêm vế phường chỉ
   * làm query dài mà không thêm quyền. Một ô toàn quốc là toàn quốc: gộp danh sách tỉnh lại sẽ
   * thu hẹp oan quyền của họ.
   */
  const wholeProvinces = new Set<string>()
  const wardsByProvince = new Map<string, Set<string>>()
  let nationwide = false

  for (const g of axisGrants) {
    if (g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE) {
      if (!g.provinceCodes || g.provinceCodes.length === 0) nationwide = true
      else g.provinceCodes.forEach((p) => wholeProvinces.add(p))
      continue
    }
    const province = g.provinceCodes?.[0]
    if (!province) continue
    const wards = wardsByProvince.get(province) ?? new Set<string>()
    for (const w of g.wardCodes ?? []) wards.add(w)
    wardsByProvince.set(province, wards)
  }

  const cells = nationwide
    ? null
    : [
        ...[...wholeProvinces].map((province) => ({ province, wards: null })),
        ...[...wardsByProvince]
          .filter(([province]) => !wholeProvinces.has(province))
          .map(([province, wards]) => ({ province, wards: [...wards] })),
      ]

  runWithTenant({ ...currentScope()!, publicAxis: { mode: 'moderator', categoryIds, cells } }, next)
})

/**
 * Cửa cho hai thao tác GHI dùng chung cả hai trục: đổi trạng thái và gỡ tin.
 *
 * Cố tình KHÔNG hỏi "bạn đang đứng trong nhóm nào" (`requireOrg`) — đó là câu hỏi của trục org,
 * và trục danh mục không có câu trả lời: người phụ trách (danh mục × tỉnh) thường chẳng thuộc
 * nhóm nào. Hỏi nhầm câu đó chính là thứ từng khoá chặt cả trục công khai: hàng đợi liệt kê ra
 * được mà không ai bấm duyệt nổi, kể cả master, nên tin công khai của người không có nhóm kẹt
 * `pending` vĩnh viễn.
 *
 * Ở đây chỉ chốt "người này có quyền duyệt Ở ĐÂU ĐÓ không" — đủ để chặn người dùng thường.
 * Thẩm quyền trên ĐÚNG tin đang xét do `assertCanModerateListing` phán, vì chỉ nó mới biết tin
 * thuộc trục nào.
 */
export const requireAnyModerator = catchAsync(async (req, _res, next) => {
  const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
  req.grants = grants

  const moderatesSomething =
    isMaster(grants) ||
    grants.some(
      (g) =>
        g.scopeType === SCOPE_TYPES.ORG ||
        g.scopeType === SCOPE_TYPES.ORG_UNIT ||
        g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE ||
        g.scopeType === SCOPE_TYPES.CATEGORY_WARD,
    )
  if (!moderatesSomething) throw new ForbiddenError('Bạn không có quyền duyệt tin')

  next()
})

/**
 * Master thấy toàn bộ trục công khai — dùng cho dashboard phủ sóng và hàng đợi fallback.
 * `categoryIds: []` ở scope nghĩa là "không giới hạn danh mục", xem `publicPredicate`.
 */
export const requireMasterPublicAxis = catchAsync(async (req, _res, next) => {
  const grants = req.grants ?? (await roleGrantService.grantsOf(req.user!.id))
  req.grants = grants
  if (!isMaster(grants)) throw new ForbiddenError('Cần quyền master')

  runWithTenant(
    { ...currentScope()!, publicAxis: { mode: 'moderator', categoryIds: [], cells: null } },
    next,
  )
})
