import { ApiError, ErrorDetail } from './ApiError'
import { httpStatus } from '../constants/httpStatus'

export class BadRequestError extends ApiError {
  constructor(message = 'Bad Request', details: ErrorDetail[] | null = null) {
    super(httpStatus.BAD_REQUEST, message, { details })
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(httpStatus.UNAUTHORIZED, message)
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(httpStatus.FORBIDDEN, message)
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(httpStatus.NOT_FOUND, message)
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict', details: ErrorDetail[] | null = null) {
    super(httpStatus.CONFLICT, message, { details })
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests') {
    super(httpStatus.TOO_MANY_REQUESTS, message)
  }
}

export class NotImplementedError extends ApiError {
  constructor(message = 'Not implemented') {
    super(httpStatus.NOT_IMPLEMENTED, message)
  }
}

export { ApiError }
export type { ErrorDetail }
