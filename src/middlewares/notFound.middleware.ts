import { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../common/errors'
import { sanitizeUrl } from '../common/observability/redact'

export function notFound(req: Request, _res: Response, next: NextFunction) {
  // Thông điệp này đi vào log lỗi — không được kèm `?code=` của link xác thực gõ sai đường.
  next(new NotFoundError(`Route not found: ${req.method} ${sanitizeUrl(req.originalUrl)}`))
}
