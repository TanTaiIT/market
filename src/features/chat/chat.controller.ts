import { chatService } from './chat.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const chatController = {
  // POST /chats
  open: catchAsync(async (req, res) => {
    const conversation = await chatService.open(req.body, req.user!)
    created(res, { message: 'Conversation opened', data: conversation })
  }),

  // GET /chats
  list: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.list(req.query as never, req.user!)
    success(res, { message: 'Conversations', data: items, meta })
  }),

  // GET /chats/:id
  getById: catchAsync(async (req, res) => {
    const conversation = await chatService.getById(req.params.id, req.user!)
    success(res, { message: 'Conversation detail', data: conversation })
  }),

  // GET /chats/:id/messages
  messages: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.messages(req.params.id, req.query as never, req.user!)
    success(res, { message: 'Messages', data: items, meta })
  }),

  // POST /chats/:id/messages
  send: catchAsync(async (req, res) => {
    const message = await chatService.send(req.params.id, req.body, req.user!)
    created(res, { message: 'Message sent', data: message })
  }),

  // PATCH /chats/:id/read
  markRead: catchAsync(async (req, res) => {
    const conversation = await chatService.markRead(req.params.id, req.user!)
    success(res, { message: 'Conversation marked as read', data: conversation })
  }),
}
