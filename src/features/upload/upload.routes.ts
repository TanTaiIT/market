import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(upload): POST /images -> nhận multipart, đẩy lên S3/Cloudinary, trả về URL.
//
// Không còn middleware dựng sẵn: `upload.middleware.ts` (multer memoryStorage) và
// `uploadLimiter` đã bị gỡ cùng package `multer` — chúng chưa từng được route nào nạp, tức là
// hạ tầng nằm chờ một feature chưa có. Khi làm thật thì cài lại `multer` (hoặc thứ tương
// đương) và thêm một `createRateLimiter({ keyPrefix: 'rl:upload', ... })` ngay lúc đó.
router.use((_req, _res, next) => next(new NotImplementedError('upload module chưa triển khai')))

export default router
