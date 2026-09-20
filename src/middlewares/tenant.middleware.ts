import { Types } from 'mongoose'
import { Request } from 'express'
import { catchAsync } from '../common/utils/catchAsync'
import { ForbiddenError } from '../common/errors'
import { TenantScope, publicOnlyScope, runWithTenant } from '../common/tenant/tenantContext'
import { canModerateAnyInOrg } from '../common/authz/policy'
import { verifyAccessToken } from '../common/utils/jwt'
import {
  organizationRepository,
  OrgSummary,
} from '../features/organization/organization.repository'
import { membershipRepository } from '../features/membership/membership.repository'
import { roleGrantService } from '../features/role-grant/role-grant.service'
import { enrichRequestContext } from '../common/observability/requestContext'

/** Header client khai org đang thao tác — `_id` của org, định danh duy nhất của một nhóm. */
const ORG_HEADER = 'x-org-id'

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

function headerOrgId(req: Request): string | null {
  const value = req.headers[ORG_HEADER]
  return typeof value === 'string' && value ? value : null
}

/** Best-effort: token hỏng để `authenticate` trả 401 với thông điệp đúng, đừng đoán ở đây. */
function actorIdOf(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return null
  try {
    return verifyAccessToken(header.slice(7)).sub
  } catch {
    return null
  }
}

async function resolveById(id: string): Promise<OrgSummary> {
  // Không phải ObjectId thì không tra: Mongoose ném CastError, tức 500 cho một header client
  // gõ sai — trong khi câu trả lời đúng là cùng một 403 với org không tồn tại.
  const org = OBJECT_ID.test(id) ? await organizationRepository.findActiveById(id) : null
  if (!org) throw new ForbiddenError('Organization không tồn tại hoặc đã bị khoá')
  return org
}

/**
 * Org hoạt động của request.
 *
 * Không suy diễn khi mơ hồ: user thuộc nhiều org mà không chỉ ra org nào thì KHÔNG mở scope,
 * thay vì đoán lấy cái đầu tiên. Đoán ở đây nghĩa là tin đăng lặng lẽ rơi vào hàng đợi của tổ
 * chức khác — đúng thứ nguyên tắc "không resolve ngầm" (§6.2) sinh ra để chặn.
 */
async function resolveOrganization(
  req: Request,
  memberOrgIds: Types.ObjectId[],
): Promise<OrgSummary | null> {
  const orgId = headerOrgId(req)
  if (orgId) {
    // Ghi vào ngữ cảnh log trước khi tra: id KHÔNG tra ra org cũng là thông tin cần khi một
    // nhóm báo "chúng tôi không vào được" — biết họ đã gửi id gì mới lần được nguyên nhân.
    enrichRequestContext({ orgId })
    return resolveById(orgId)
  }
  if (memberOrgIds.length !== 1) return null

  return organizationRepository.findActiveById(memberOrgIds[0])
}

/**
 * Mở tenant scope cho phần còn lại của request.
 *
 * Khác bản v1 ở chỗ căn bản: org KHÔNG còn nằm trong token. Nó do request chỉ ra (header) và
 * được đối chiếu với `memberships` NGAY LÚC ĐÓ — rời org là mất quyền ngay, không phải chờ
 * token hết hạn.
 */
/**
 * Đường phiên đăng nhập: KHÔNG mang tổ chức.
 *
 * Client gắn `X-Org-Id` vào MỌI request. Nếu org đang chọn bị khoá thì `resolveById` ném
 * 403 — kể cả trên `/auth/refresh`, tức là chính lối tự cứu phiên bị header org làm chết, rồi
 * app đăng xuất người dùng vì một lý do không liên quan gì tới phiên của họ.
 *
 * An toàn vì `auth.service` không đọc scope org nào: nó chỉ tra `userRepository`. Vẫn mở scope
 * CÔNG KHAI chứ không bỏ trắng — `tenantPlugin` fail-closed, thiếu scope là mọi truy vấn bên
 * trong ném "Missing tenant context".
 */
const SESSION_PATH = /^\/auth\//

export const resolveTenant = catchAsync(async (req, _res, next) => {
  if (SESSION_PATH.test(req.path)) return runWithTenant(publicOnlyScope(), next)

  const actorId = actorIdOf(req)

  /*
   * Nạp membership cho MỌI request đã đăng nhập, không chỉ nhánh không-header.
   *
   * Đây là thứ cho phép bỏ khái niệm "tổ chức đang thao tác": bảng tin đọc được tin của mọi
   * nhóm mình ở trong cùng lúc, nên người thuộc hai nhóm không phải bấm chọn nhóm nào — và
   * không còn cảnh chưa chọn thì không thấy tin nội bộ nào cả.
   *
   * Một lượt tra có index trên `userId`, trả về vài bản ghi; và nó THAY cho lượt tra cũ vốn
   * chạy ở nhánh không-header, chứ không cộng thêm.
   */
  const memberOrgIds = actorId
    ? (await membershipRepository.listActiveByUser(actorId)).map((m) => m.organizationId)
    : []

  const org = await resolveOrganization(req, memberOrgIds)

  // Không xác định được org KHÔNG còn nghĩa là không có scope: tin công khai (trục danh mục)
  // đọc được mà không cần thuộc tổ chức nào — kể cả khách chưa đăng nhập. Nhưng nhóm MÌNH ĐÃ
  // VÀO thì vẫn đọc được, và đó là ca của người thuộc nhiều nhóm chưa gửi header.
  if (!org) return runWithTenant(publicOnlyScope(memberOrgIds), next)

  const withOrg = (): TenantScope => ({
    ownOrgId: org._id,
    readableOrgIds: [org._id],
    memberOrgIds,
    publicAxis: { mode: 'approved' },
  })

  /*
   * KHÁCH (không token): chỉ trục công khai, KHÔNG `readableOrgIds`.
   *
   * Bản trước cấp `withOrg()` ở đây với lý do "khách xem trang công khai của org qua subdomain".
   * Ý định đúng, cấp sai thứ: `withOrg()` mở luôn NHÁNH ORG của `tenantPlugin`, nên chỉ cần gửi
   * `X-Org-Id: <id>` — mà id nằm trong mọi link chia sẻ — là đọc được tin `org_internal`
   * của nhóm đó, không cần đăng nhập. Đo được: 4/50 tin trả về là tin nội bộ của nhóm.
   *
   * Điều đó mâu thuẫn thẳng với lời app hứa ở hồ sơ nhóm: "Đây là nội dung riêng của nhóm.
   * Tham gia để xem tin đăng bên trong."
   *
   * Trang công khai của org KHÔNG cần scope này: `organizationService.publicProfile` đọc
   * `Organization`/`Membership` (hai model không gắn plugin) và đếm tin qua
   * `countCreatedSinceForOrg`, vốn tự khai `runUnscoped`.
   */
  if (!actorId) return runWithTenant(publicOnlyScope(), next)

  // Từ đây trở xuống người gọi ĐÃ đăng nhập, nên mọi nhánh `publicOnlyScope` còn lại phải mang
  // theo `memberOrgIds` — họ không quản trị org trong header, nhưng nhóm của chính họ thì vẫn đọc.

  const membership = await membershipRepository.findActive(actorId, org._id)
  if (membership) {
    req.membership = {
      id: membership._id.toString(),
      role: membership.role,
      unitId: membership.unitId?.toString() ?? null,
    }
    return runWithTenant(withOrg(), next)
  }

  // Không phải thành viên. Có quyền hệ thống trên chính org này (master / manager org / staff
  // nhóm con) thì vào bình thường.
  req.grants = await roleGrantService.grantsOf(actorId)
  if (canModerateAnyInOrg(req.grants, org._id.toString())) {
    return runWithTenant(withOrg(), next)
  }

  /*
   * NGƯỜI NGOÀI đã đăng nhập: cũng chỉ trục công khai, bất kể method.
   *
   * Bản trước có một nhánh riêng `if (req.method === 'GET') return runWithTenant(withOrg(), ...)`
   * — "mở scope ĐỌC của org cho GET, còn ghi thì không". Đó chính là lỗ hổng, chỉ khác ca khách
   * ở chỗ có token: `readableOrgIds` mở nhánh org, nên `GET /listings` kèm `X-Org-Id` trả về
   * tin nội bộ của một nhóm mình không thuộc.
   *
   * Bỏ nhánh đó KHÔNG làm route nào hỏng oan: mọi GET thật sự cần `ownOrgId` đều đã gác thêm
   * `requireOrgAdmin`/`requireOrgModerator`/`requireOrgReadOrMaster`, tức người ngoài vốn đã
   * nhận 403 ở đó. Còn người ngoài CÓ quyền duyệt trong org thì đã rẽ ở nhánh trên.
   *
   * Các route không cần org (gửi đơn tham gia, đăng tin trục công khai, xem hồ sơ nhóm) vẫn
   * chạy bình thường — chúng đọc những model không gắn `tenantPlugin`.
   */
  runWithTenant(publicOnlyScope(memberOrgIds), next)
})
