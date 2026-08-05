import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(notification): danh sách/đánh dấu đã đọc thông báo; phát realtime qua Socket.IO;
// gửi bất đồng bộ qua BullMQ (email, push).
router.all('/*', (_req, _res, next) =>
  next(new NotImplementedError('notification module chưa triển khai')),
)

export default router
