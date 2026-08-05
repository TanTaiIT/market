export interface ErrorDetail {
  path: string
  message: string
}

export class ApiError extends Error {
  public readonly statusCode: number

  public readonly isOperational: boolean

  public readonly details?: ErrorDetail[] | null

  constructor(
    statusCode: number,
    message: string,
    options: { isOperational?: boolean; details?: ErrorDetail[] | null } = {},
  ) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = options.isOperational ?? true
    this.details = options.details ?? null
    Error.captureStackTrace(this, this.constructor)
  }
}
