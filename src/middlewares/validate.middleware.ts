import { Request, Response, NextFunction } from 'express'
import { z, ZodTypeAny, ZodError } from 'zod'
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

/**
 * Đọc `req.query` ĐÃ QUA `validate({ query })` với đúng kiểu của schema đó (audit 5.5). Không parse
 * lại — middleware đã ép kiểu và gán ngược vào `req.query`; hàm này chỉ buộc KIỂU vào schema, thay
 * cho `as never` rải ở 23 controller. Truyền schema lệch với route là lỗi review, không phải runtime.
 */
export const queryOf = <S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> =>
  req.query as unknown as z.infer<S>
