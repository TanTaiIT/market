import { Request, Response, NextFunction } from 'express'
import mongoose from 'mongoose'
import { ApiError } from '../common/errors/ApiError'
import { httpStatus } from '../common/constants/httpStatus'
import { env } from '../config/env'
import { logger } from '../config/logger'

/**
 * Chuyển mọi lỗi (Mongoose, JWT, lỗi thường...) về ApiError chuẩn.
 */
export function errorConverter(err: unknown, _req: Request, _res: Response, next: NextFunction) {
  if (err instanceof ApiError) return next(err)

  let statusCode: number = httpStatus.INTERNAL_SERVER_ERROR
  let message = err instanceof Error ? err.message : 'Internal Server Error'

  if (err instanceof mongoose.Error.ValidationError) {
    statusCode = httpStatus.BAD_REQUEST
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ')
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = httpStatus.BAD_REQUEST
    message = `Invalid ${err.path}: ${err.value}`
  } else if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    statusCode = httpStatus.CONFLICT
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {}
    message = `Duplicate value for field "${Object.keys(keyValue)[0]}"`
  } else if (
    err instanceof Error &&
    ['JsonWebTokenError', 'TokenExpiredError'].includes(err.name)
  ) {
    statusCode = httpStatus.UNAUTHORIZED
    message = 'Invalid or expired token'
  }

  next(new ApiError(statusCode, message))
}

/**
 * Global error handler cuối chuỗi middleware.
 *
 * `_next` không dùng nhưng phải khai: Express nhận diện error handler bằng đúng arity 4.
 */
export function errorHandler(err: ApiError, req: Request, res: Response, _next: NextFunction) {
  const statusCode = err.statusCode ?? httpStatus.INTERNAL_SERVER_ERROR

  if (statusCode >= 500) {
    logger.error(err.message, { err, path: req.originalUrl, method: req.method })
  }

  res.status(statusCode).json({
    success: false,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
    ...(env.isDev && { stack: err.stack }),
  })
}
