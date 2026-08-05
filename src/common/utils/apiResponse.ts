import { Response } from 'express'

interface SuccessOptions<T> {
  statusCode?: number
  message?: string
  data?: T
  meta?: unknown
}

/**
 * Chuẩn hoá response toàn app: { success, message, data, meta? }.
 */
export function success<T>(res: Response, opts: SuccessOptions<T> = {}): Response {
  const { statusCode = 200, message = 'OK', data = null, meta } = opts
  const body: Record<string, unknown> = { success: true, message, data }
  if (meta !== undefined) body.meta = meta
  return res.status(statusCode).json(body)
}

export function created<T>(
  res: Response,
  opts: Omit<SuccessOptions<T>, 'statusCode'> = {},
): Response {
  return success(res, { ...opts, statusCode: 201, message: opts.message ?? 'Created' })
}

export function noContent(res: Response): Response {
  return res.status(204).send()
}
