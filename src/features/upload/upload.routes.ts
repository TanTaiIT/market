import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(upload): POST /images (multer memory) -> đẩy lên S3/Cloudinary -> trả về URL.
// Dùng sẵn: upload.middleware (multer memoryStorage) + uploadLimiter.
// Ví dụ: router.post('/images', authenticate, uploadLimiter, upload.array('images', 10), handler)
router.use((_req, _res, next) => next(new NotImplementedError('upload module chưa triển khai')))

export default router
