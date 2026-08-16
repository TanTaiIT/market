import { chatService } from './chat.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { orgActor } from '../../common/utils/actor'
import { success, created } from '../../common/utils/apiResponse'

export const chatController = {
  // POST /chats
  open: catchAsync(async (req, res) => {
    const conversation = await chatService.open(req.body, orgActor(req, 'chat.open'))
    created(res, { message: 'Conversation opened', data: conversation })
  }),

  // GET /chats
  list: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.list(req.query as never, orgActor(req, 'chat.list'))
    success(res, { message: 'Conversations', data: items, meta })
  }),

  // GET /chats/:id
  getById: catchAsync(async (req, res) => {
    const conversation = await chatService.getById(req.params.id, orgActor(req, 'chat.getById'))
    success(res, { message: 'Conversation detail', data: conversation })
  }),

  // GET /chats/:id/messages
  messages: catchAsync(async (req, res) => {
    const { items, meta } = await chatService.messages(
      req.params.id,
      req.query as never,
      orgActor(req, 'chat.messages'),
    )
    success(res, { message: 'Messages', data: items, meta })
  }),

  // POST /chats/:id/messages
  send: catchAsync(async (req, res) => {
    const message = await chatService.send(req.params.id, req.body, orgActor(req, 'chat.send'))
    created(res, { message: 'Message sent', data: message })
  }),

  // PATCH /chats/:id/read
  markRead: catchAsync(async (req, res) => {
    const conversation = await chatService.markRead(req.params.id, orgActor(req, 'chat.markRead'))
    success(res, { message: 'Conversation marked as read', data: conversation })
  }),
}
