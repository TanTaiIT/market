export interface ErrorDetail {
  path: string
  message: string
}

export class ApiError extends Error {
  public readonly statusCode: number

  public readonly details?: ErrorDetail[] | null

  constructor(
    statusCode: number,
    message: string,
    options: { details?: ErrorDetail[] | null } = {},
  ) {
    super(message)
    this.statusCode = statusCode
    this.details = options.details ?? null
    Error.captureStackTrace(this, this.constructor)
  }
}
