import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from '../common/utils/jwt'
import { UnauthorizedError, ForbiddenError } from '../common/errors'
import { catchAsync } from '../common/utils/catchAsync'
import { Role } from '../common/constants'

function extractToken(req: Request): string | null {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Bắt buộc đăng nhập. Gán req.user = { id, role }.
 */
export const authenticate = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (!token) throw new UnauthorizedError('Missing access token')

  const payload = verifyAccessToken(token)
  req.user = { id: payload.sub, role: payload.role }
  next()
})

/**
 * Không bắt buộc đăng nhập — gán req.user nếu token hợp lệ, bỏ qua nếu không.
 */
export const optionalAuth = catchAsync(async (req, _res, next) => {
  const token = extractToken(req)
  if (token) {
    try {
      const payload = verifyAccessToken(token)
      req.user = { id: payload.sub, role: payload.role }
    } catch {
      // token hỏng -> coi như khách
    }
  }
  next()
})

/**
 * Phân quyền theo role. Ví dụ: authorize(ROLES.ADMIN)
 */
export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError())
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have permission to perform this action'))
    }
    next()
  }
