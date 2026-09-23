import { Router } from 'express'
import { uploadService } from './upload.service'
import { uploadSignatureResponseSchema } from './upload.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'
import { authenticate } from '../../middlewares/auth.middleware'
import { createRateLimiter } from '../../middlewares/rateLimiter.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

/*
 * 60 lượt / phút / tài khoản.
 *
 * Một tin tối đa 12 ảnh, mỗi ảnh một chữ ký, và người dùng có thể bỏ rồi chọn lại vài lượt — nên
 * trần phải rộng hơn hẳn 12. Nó không nhằm chặn người dùng thật mà chặn một tài khoản bị chiếm
 * dụng để bơm ảnh: cửa upload giờ đi qua đây, nên đây là chỗ đếm được.
 */
const signatureLimiter = createRateLimiter({ keyPrefix: 'rl:upload', points: 60, duration: 60 })

/*
 * KHÔNG nhận file. Ảnh vẫn đi thẳng từ máy người dùng lên Cloudinary — server chỉ ký.
 *
 * Đẩy file qua server sẽ tốn băng thông gấp đôi và biến mỗi lượt đăng tin thành một request
 * multipart vài MB đi qua instance; ký thì chỉ là một phép băm. Đây cũng là lý do module này
 * không cần `multer` như TODO cũ dự tính.
 */
router.post(
  '/signature',
  authenticate,
  signatureLimiter,
  catchAsync(async (_req, res) => {
    success(res, { message: 'Upload signature', data: uploadService.signature() })
  }),
)

// ── OPENAPI ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/uploads/signature',
  operationId: 'uploadSignature',
  tags: ['Upload'],
  summary: 'Chữ ký cho một lượt upload ảnh lên Cloudinary',
  description:
    'Preset Cloudinary chạy ở chế độ **Signed**, nên app phải gửi kèm `api_key`, `timestamp` và ' +
    '`signature`. Chữ ký được tính từ `api_secret` — thứ chỉ tồn tại ở server. ' +
    'Gọi một lần cho MỖI ảnh: `timestamp` nằm trong chữ ký nên không dùng lại được lâu.\n\n' +
    'Gửi lên Cloudinary đúng các trường: `file`, `api_key`, `timestamp`, `signature`, `folder`, ' +
    '`upload_preset` — thừa hoặc thiếu một trường được ký đều làm chữ ký sai.',
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: jsonResponse('Chữ ký upload', envelope(uploadSignatureResponseSchema)),
    401: errorResponse('Chưa đăng nhập'),
    429: errorResponse('Quá nhiều lượt xin chữ ký'),
    501: errorResponse('Server chưa cấu hình CLOUDINARY_*'),
  },
})

export default router
