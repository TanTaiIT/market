import { z } from 'zod'
import { registry } from '../../config/openapi'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const openConversationSchema = z
  .object({ listingId: objectId })
  .strict()
  .openapi('OpenConversation')

export const sendMessageSchema = z
  .object({
    text: z.string().trim().min(1, 'Tin nhắn không được rỗng').max(2000),
    // Server không sinh, không kiểm tra ý nghĩa, chỉ trả lại nguyên vẹn để client ghép bong
    // bóng lạc quan với bản thật. `.strict()` ở đây nên thiếu khai báo là request bị 400.
    clientMsgId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .openapi('SendMessage')

export const conversationParamsSchema = z.object({ id: objectId })

export const conversationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const conversationResponseSchema = z
  .object({
    id: objectId,
    listingId: objectId,
    listingTitle: z.string(),
    /** Người còn lại — client không phải tự suy từ mảng participants. */
    partnerId: objectId,
    partnerName: z.string(),
    /** Snapshot lúc mở hội thoại. `''` = chưa đặt ảnh — client rơi về chữ viết tắt. */
    partnerAvatar: z.string(),
    lastMessage: z.string(),
    lastMessageAt: z.string().datetime(),
    unread: z.boolean().openapi({
      description: 'Có tin mới do người kia gửi kể từ lần mình đọc gần nhất',
    }),
  })
  .openapi('Conversation')

export const messageResponseSchema = z
  .object({
    id: objectId,
    conversationId: objectId,
    senderId: objectId,
    senderName: z.string(),
    text: z.string(),
    // Chỉ có ở tin do client đời mới gửi — client dùng nó làm khoá ổn định cho danh sách.
    clientMsgId: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .openapi('Message')

export type OpenConversationInput = z.infer<typeof openConversationSchema>
export type SendMessageInput = z.infer<typeof sendMessageSchema>
export type ConversationQuery = z.infer<typeof conversationQuerySchema>

registry.register('OpenConversation', openConversationSchema)
registry.register('SendMessage', sendMessageSchema)
registry.register('Conversation', conversationResponseSchema)
registry.register('Message', messageResponseSchema)
