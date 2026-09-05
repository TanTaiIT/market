import type { Request } from 'express'
import { chatService, type ChatActor } from './chat.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

/**
 * Actor của chat: CHỈ danh tính, không kèm org.
 *
 * Trước đây dùng `orgActor`, và nó ném `Missing tenant context for "chat.open"` ngay trước khi
 * bất kỳ luật nghiệp vụ nào kịp chạy — với mọi người dùng không thuộc đúng một nhóm. Chat
 * không cần org nữa (xem `chat.model.ts`), nên lấy thẳng id là đủ và cũng là tất cả.
 *
 * Không dùng lại `moderatorActor` dù thân hàm giống hệt: tên của nó nói về luồng duyệt tin,
 * và một helper dùng chung sẽ che mất việc hai luồng này rút quyền từ hai nguồn khác nhau.
 */
const actorOf = (req: Request): ChatActor => ({ id: req.user!.id })

export const chatController = {
  // POST /chats
  open: catchAsync(async (req, res) => {
    const conversation = await chatService.open(req.body, actorOf(req))
    created(res, { message: 'Conversation opened', data: conversation })
  }),

  // GET /chats
  list: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.list(req.query as never, actorOf(req))
    success(res, { message: 'Conversations', data: items, meta })
  }),

  // GET /chats/:id
  getById: catchAsync(async (req, res) => {
    const conversation = await chatService.getById(req.params.id, actorOf(req))
    success(res, { message: 'Conversation detail', data: conversation })
  }),

  // GET /chats/:id/messages
  messages: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.messages(
      req.params.id,
      req.query as never,
      actorOf(req),
    )
    success(res, { message: 'Messages', data: items, meta })
  }),

  // POST /chats/:id/messages
  send: catchAsync(async (req, res) => {
    const message = await chatService.send(req.params.id, req.body, actorOf(req))
    created(res, { message: 'Message sent', data: message })
  }),

  // PATCH /chats/:id/read
  markRead: catchAsync(async (req, res) => {
    const conversation = await chatService.markRead(req.params.id, actorOf(req))
    success(res, { message: 'Conversation marked as read', data: conversation })
  }),
}
