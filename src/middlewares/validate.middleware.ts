import { Request, Response, NextFunction } from 'express'
import { ZodTypeAny, ZodError } from 'zod'
import { BadRequestError } from '../common/errors'

export interface RequestSchemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
}

/**
 * Generic validate middleware dùng zod. Dữ liệu sau parse (đã ép kiểu) được gán lại vào req.
 */
export const validate =
  (schema: RequestSchemas) => (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.params) req.params = schema.params.parse(req.params)
      if (schema.query) req.query = schema.query.parse(req.query)
      if (schema.body) req.body = schema.body.parse(req.body)
      return next()
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }))
        return next(new BadRequestError('Validation failed', details))
      }
      return next(err)
    }
  }
