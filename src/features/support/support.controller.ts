import { supportService } from './support.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'
import { SupportQueueQuery } from './support.schema'

export const supportController = {
  // GET /support/me
  myThread: catchAsync(async (req, res) => {
    const data = await supportService.myThread(req.user!.id)
    success(res, { message: 'Support thread', data })
  }),

  // POST /support/me/messages
  send: catchAsync(async (req, res) => {
    const data = await supportService.send(req.user!.id, req.body.body)
    success(res, { message: 'Đã gửi cho đội ngũ hỗ trợ', data })
  }),

  // POST /support/me/read
  markRead: catchAsync(async (req, res) => {
    const data = await supportService.markRead(req.user!.id)
    success(res, { message: 'Đã đánh dấu đã đọc', data })
  }),

  // GET /support/threads
  queue: catchAsync(async (req, res) => {
    const { items, meta } = await supportService.queue(req.query as unknown as SupportQueueQuery)
    success(res, { message: 'Support queue', data: items, meta })
  }),

  // GET /support/threads/:id
  threadForMaster: catchAsync(async (req, res) => {
    const data = await supportService.threadForMaster(req.params.id)
    success(res, { message: 'Support thread', data })
  }),

  // POST /support/threads/:id/reply
  reply: catchAsync(async (req, res) => {
    const data = await supportService.reply(req.params.id, req.user!.id, req.body.body)
    success(res, { message: 'Đã trả lời', data })
  }),
}
