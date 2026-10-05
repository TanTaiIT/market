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

/**
 * Ví không đủ Xu. 402 chứ không 400: client phân biệt được "gõ sai" với "hết tiền" mà không
 * phải đọc chuỗi thông báo — cái sau dẫn thẳng sang màn nạp.
 */
export class InsufficientBalanceError extends ApiError {
  constructor(message = 'Số dư Xu không đủ') {
    super(httpStatus.PAYMENT_REQUIRED, message)
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

/** Tính năng đang tắt vì thiếu hạ tầng (mail…) — lỗi của HỆ THỐNG, nói thẳng thay vì im lặng 200. */
export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Tạm không khả dụng') {
    super(httpStatus.SERVICE_UNAVAILABLE, message)
  }
}

/**
 * Luật nghiệp vụ vi phạm ở TẦNG MODEL (`pre('validate')`). Model không biết HTTP nên không ném
 * `ApiError`; lớp riêng để `errorConverter` nhận ra và trả 400 — thay cho việc service dò
 * `constructor === Error`, thứ vừa mong manh vừa biến mọi Error trơn khác thành 400 (audit 5.8).
 */
export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainRuleError'
  }
}

export { ApiError }
export type { ErrorDetail }
