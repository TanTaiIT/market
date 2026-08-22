import { Request } from 'express'
import { env } from '../config/env'
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

/** Header cho client không chạy trên subdomain (app mobile, dev). Subdomain vẫn thắng. */
const ORG_HEADER = 'x-org-slug'

function subdomainSlug(hostname: string): string | null {
  const base = env.APP_BASE_DOMAIN
  if (!base || !hostname.endsWith(`.${base}`)) return null

  const sub = hostname.slice(0, -(base.length + 1))
  return sub && sub !== 'www' ? sub : null
}

function headerSlug(req: Request): string | null {
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

async function resolveBySlug(slug: string): Promise<OrgSummary> {
  const org = await organizationRepository.findActiveBySlug(slug)
  if (org) return org

  // Slug cũ sau khi tổ chức đổi tên. Không tra bảng alias ở đây thì mọi URL đã phát ra ngoài
  // chết ngay lúc đổi slug — và bảng alias trở thành dữ liệu ghi ra rồi không ai đọc.
  const aliasTarget = await organizationRepository.findAliasTarget(slug)
  const renamed = aliasTarget ? await organizationRepository.findActiveById(aliasTarget) : null
  if (!renamed) throw new ForbiddenError('Organization không tồn tại hoặc đã bị khoá')
  return renamed
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
  actorId: string | null,
): Promise<OrgSummary | null> {
  const slug = subdomainSlug(req.hostname) ?? headerSlug(req)
  if (slug) return resolveBySlug(slug)
  if (!actorId) return null

  const memberships = await membershipRepository.listActiveByUser(actorId)
  if (memberships.length !== 1) return null

  return organizationRepository.findActiveById(memberships[0].organizationId)
}

/**
 * Mở tenant scope cho phần còn lại của request.
 *
 * Khác bản v1 ở chỗ căn bản: org KHÔNG còn nằm trong token. Nó do request chỉ ra (subdomain /
 * header) và được đối chiếu với `memberships` NGAY LÚC ĐÓ — rời org là mất quyền ngay, không
 * phải chờ token hết hạn.
 */
export const resolveTenant = catchAsync(async (req, _res, next) => {
  const actorId = actorIdOf(req)
  const org = await resolveOrganization(req, actorId)

  // Không xác định được org KHÔNG còn nghĩa là không có scope: tin công khai (trục danh mục)
  // đọc được mà không cần thuộc tổ chức nào — kể cả khách chưa đăng nhập.
  if (!org) return runWithTenant(publicOnlyScope(), next)

  const withOrg = (): TenantScope => ({
    ownOrgId: org._id,
    readableOrgIds: [org._id],
    publicAxis: { mode: 'approved' },
  })

  if (!actorId) {
    // Khách xem trang công khai của org qua subdomain. Không có token thì không có đường ghi.
    return runWithTenant(withOrg(), next)
  }

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

  // Người ngoài: mở scope ĐỌC của org cho GET, còn ghi thì không. Không ném lỗi ở đây — không
  // mở scope org thì `tenantPlugin` fail-closed tự chặn đường ghi vào org, và những route
  // không cần org (gửi đơn tham gia, đăng tin trục công khai) vẫn chạy thay vì ăn 403 oan.
  if (req.method === 'GET') return runWithTenant(withOrg(), next)

  runWithTenant(publicOnlyScope(), next)
})
