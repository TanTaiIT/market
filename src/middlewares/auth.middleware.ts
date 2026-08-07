import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken, TOKEN_TYPE, UserJwtPayload } from '../common/utils/jwt'
import { UnauthorizedError, ForbiddenError } from '../common/errors'
import { catchAsync } from '../common/utils/catchAsync'
import { currentScope } from '../common/tenant/tenantContext'
import { OrgRole } from '../common/constants'

function extractToken(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Token của user và token của platform-admin ký cùng secret, nên `type` là thứ duy nhất
 * ngăn token bên này đi vào route bên kia.
 *
 * Ràng buộc thứ hai: org trong token phải khớp org đã resolve từ subdomain — nếu không,
 * user org A cầm token của mình gọi vào subdomain org B sẽ chạy với scope của B.
 */
function readUserPayload(token: string): UserJwtPayload {
  const payload = verifyAccessToken(token)
  if (payload.type !== TOKEN_TYPE.USER) throw new UnauthorizedError('Invalid access token')

  const scope = currentScope()
  if (!scope?.ownOrgId) throw new ForbiddenError('Missing tenant context')
  if (payload.organizationId !== scope.ownOrgId.toString()) {
    throw new ForbiddenError('Token thuộc organization khác')
  }
  return payload
}

/**
 * Bắt buộc đăng nhập. Gán req.user = { id, organizationId, role }.
 */
export const authenticate = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (!token) throw new UnauthorizedError('Missing access token')

  const payload = readUserPayload(token)
  req.user = { id: payload.sub, organizationId: payload.organizationId, role: payload.role }
  next()
})

/**
 * Không bắt buộc đăng nhập — gán req.user nếu token hợp lệ, bỏ qua nếu không.
 */
export const optionalAuth = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (token) {
    try {
      const payload = readUserPayload(token)
      req.user = { id: payload.sub, organizationId: payload.organizationId, role: payload.role }
    } catch {
      // token hỏng hoặc thuộc org khác -> coi như khách
    }
  }
  next()
})

/**
 * Phân quyền theo role trong org. Ví dụ: authorize(ORG_ROLES.OWNER, ORG_ROLES.MODERATOR)
 */
export const authorize =
  (...roles: OrgRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError())
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have permission to perform this action'))
    }
    next()
  }
