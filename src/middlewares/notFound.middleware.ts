import { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../common/errors'

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`))
}
