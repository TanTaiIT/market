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

  const cells = grants.filter((g) => g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE)

  // Master thấy toàn bộ trục công khai: chính họ là fallback của mọi ô chưa có người phụ trách.
  if (isMaster(grants)) {
    return runWithTenant(
      {
        ...currentScope()!,
        publicAxis: { mode: 'moderator', categoryIds: [], provinceCodes: null },
      },
      next,
    )
  }

  if (cells.length === 0) throw new ForbiddenError('Bạn không phụ trách danh mục nào')

  const categoryIds = cells.map((g) => new Types.ObjectId(g.categoryId!))
  // Một ô toàn quốc là toàn quốc: gộp danh sách tỉnh lại sẽ thu hẹp oan quyền của họ.
  const nationwide = cells.some((g) => !g.provinceCodes || g.provinceCodes.length === 0)
  const provinceCodes = nationwide ? null : [...new Set(cells.flatMap((g) => g.provinceCodes!))]

  runWithTenant(
    { ...currentScope()!, publicAxis: { mode: 'moderator', categoryIds, provinceCodes } },
    next,
  )
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
        g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE,
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
    { ...currentScope()!, publicAxis: { mode: 'moderator', categoryIds: [], provinceCodes: null } },
    next,
  )
})
