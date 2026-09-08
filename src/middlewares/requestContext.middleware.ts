import { Request, Response, NextFunction } from 'express'
import { runWithRequestContext, sanitizeRequestId } from '../common/observability/requestContext'

/** Header truyền id xuyên tầng — tên chuẩn de facto, mọi proxy/log tool đều hiểu. */
export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Mở ngữ cảnh chẩn đoán cho một request, và trả id đó về cho client.
 *
 * PHẢI đứng trước MỌI middleware khác trong `createApp` — kể cả access log và
 * `resolveTenant`: thứ gì chạy trước nó thì log ra không có id, đúng những dòng đầu tiên mà
 * người điều tra cần khi request chết ngay ở cửa.
 *
 * Trả `X-Request-Id` về trong response để người dùng báo lỗi kèm được đúng một chuỗi tra ra
 * toàn bộ dấu vết — thay cho "khoảng 9 giờ tối hôm qua tôi bấm gì đó rồi nó lỗi".
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = sanitizeRequestId(req.headers[REQUEST_ID_HEADER])
  res.setHeader('X-Request-Id', requestId)
  runWithRequestContext({ requestId }, next)
}
