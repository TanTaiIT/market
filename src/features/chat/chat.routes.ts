import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(chat): REST cho lịch sử hội thoại (conversation, message model);
// realtime gửi/nhận qua Socket.IO (xem src/sockets/chat.socket.ts).
router.use((_req, _res, next) => next(new NotImplementedError('chat module chưa triển khai')))

export default router
