import { Request } from 'express'
import { verifyAccessToken } from '../common/utils/jwt'
import { UnauthorizedError, ForbiddenError } from '../common/errors'
import { catchAsync } from '../common/utils/catchAsync'
import { currentScope } from '../common/tenant/tenantContext'
import { canAdminOrg, canModerateAnyInOrg, isMaster, Grant } from '../common/authz/policy'
import { roleGrantService } from '../features/role-grant/role-grant.service'

function extractToken(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/** Nạp grant một lần cho mỗi request — `resolveTenant` có thể đã nạp sẵn. */
async function loadGrants(req: Request): Promise<Grant[]> {
  if (!req.grants) req.grants = await roleGrantService.grantsOf(req.user!.id)
  return req.grants
}

/** Bắt buộc đăng nhập. Token chỉ mang `sub` — org và quyền đều nạp theo request. */
export const authenticate = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (!token) throw new UnauthorizedError('Missing access token')

  let payload
  try {
    payload = verifyAccessToken(token)
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }

  req.user = { id: payload.sub }
  next()
})

/** Không bắt buộc đăng nhập — gán req.user nếu token hợp lệ, bỏ qua nếu không. */
export const optionalAuth = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (token) {
    try {
      req.user = { id: verifyAccessToken(token).sub }
    } catch {
      // token hỏng -> coi như khách
    }
  }
  next()
})

/**
 * Route cần org hoạt động: client phải chỉ ra org (subdomain hoặc header `X-Org-Slug`), hoặc
 * chỉ thuộc đúng một org. Thông điệp nói rõ nguyên nhân vì đây là lỗi cấu hình phía client,
 * không phải lỗi quyền.
 */
export const requireOrg = catchAsync(async (req, _res, next) => {
  if (!currentScope()?.ownOrgId) {
    throw new ForbiddenError(
      'Chưa xác định được tổ chức: gửi header X-Org-Slug hoặc truy cập qua subdomain của tổ chức',
    )
  }
  next()
})

/** Chỉ thành viên của org hoạt động. Quyền hệ thống KHÔNG thay thế được tư cách thành viên. */
export const requireMembership = catchAsync(async (req, _res, next) => {
  if (!req.membership) throw new ForbiddenError('Bạn không phải thành viên của tổ chức này')
  next()
})

/**
 * Mở màn hình bàn duyệt của org hoạt động. Dùng `canModerateAnyInOrg` chứ không phải
 * `canModerateOrg`: staff nhóm con phải vào được màn hình của chính họ, việc lọc theo nhóm là
 * của tầng query bên dưới.
 */
export const requireOrgModerator = catchAsync(async (req, _res, next) => {
  const orgId = currentScope()?.ownOrgId
  if (!orgId) throw new ForbiddenError('Chưa xác định được tổ chức')

  const grants = await loadGrants(req)
  if (!canModerateAnyInOrg(grants, orgId.toString())) {
    throw new ForbiddenError('Bạn không có quyền duyệt trong tổ chức này')
  }
  next()
})

/** Đổi cấu trúc tổ chức (nhóm con, cài đặt): manager org trở lên, staff không đủ. */
export const requireOrgAdmin = catchAsync(async (req, _res, next) => {
  const orgId = currentScope()?.ownOrgId
  if (!orgId) throw new ForbiddenError('Chưa xác định được tổ chức')

  const grants = await loadGrants(req)
  if (!canAdminOrg(grants, orgId.toString())) {
    throw new ForbiddenError('Cần quyền quản lý tổ chức')
  }
  next()
})

/** Nhánh vận hành hệ thống: tạo org, cấp quyền manager, sửa từ điển danh mục. */
export const requireMaster = catchAsync(async (req, _res, next) => {
  const grants = await loadGrants(req)
  if (!isMaster(grants)) throw new ForbiddenError('Cần quyền master')
  next()
})
