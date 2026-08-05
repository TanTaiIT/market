import { Request, Response, NextFunction, RequestHandler } from 'express'

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/**
 * Bọc async handler để tự forward lỗi vào Express error handler,
 * tránh try/catch lặp lại ở mọi controller.
 */
export const catchAsync =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
