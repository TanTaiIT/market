import { ApiError } from '../errors/ApiError'
import { httpStatus } from '../constants/httpStatus'

/**
 * Ném khi một query chạm collection có tenant mà không có scope trong AsyncLocalStorage.
 * Đây là điểm fail-closed: thà 400 còn hơn im lặng query toàn bộ DB.
 */
export class TenantScopeMissingError extends ApiError {
  constructor(operation: string) {
    super(httpStatus.BAD_REQUEST, `Missing tenant context for "${operation}"`)
  }
}

/** Ném khi code chạy unscoped nhưng ghi một document không mang organizationId tường minh. */
export class CrossTenantWriteError extends ApiError {
  constructor(message = 'Unscoped write must set organizationId explicitly') {
    super(httpStatus.INTERNAL_SERVER_ERROR, message)
  }
}
