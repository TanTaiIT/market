import { z } from 'zod'
import { IConversationDocument, IMessageDocument } from './chat.model'
import { conversationResponseSchema, messageResponseSchema } from './chat.schema'

export type ConversationDto = z.infer<typeof conversationResponseSchema>
export type MessageDto = z.infer<typeof messageResponseSchema>

/**
 * DTO xoay quanh **người đang xem**: client chỉ quan tâm "người kia là ai" và "có gì mới
 * chưa", không cần cả mảng `participants` với `lastReadAt` của đối phương — đó là trạng thái
 * nội bộ và lộ ra là nói cho người này biết người kia đã đọc lúc nào.
 */
export function toConversationDto(
  conversation: IConversationDocument,
  viewerId: string,
): ConversationDto {
  const me = conversation.participants.find((p) => p.user.toString() === viewerId)
  const partner = conversation.participants.find((p) => p.user.toString() !== viewerId)

  return {
    id: conversation._id.toString(),
    listingId: conversation.listingId.toString(),
    listingTitle: conversation.listingTitle,
    partnerId: partner?.user.toString() ?? '',
    partnerName: partner?.name ?? '',
    lastMessage: conversation.lastMessage,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    // Tin cuối do chính mình gửi thì không bao giờ là "chưa đọc".
    unread:
      conversation.lastSenderId?.toString() !== viewerId &&
      (!me?.lastReadAt || me.lastReadAt < conversation.lastMessageAt),
  }
}

export function toMessageDto(message: IMessageDocument): MessageDto {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderId: message.senderId.toString(),
    senderName: message.senderName,
    text: message.text,
    clientMsgId: message.clientMsgId,
    createdAt: message.createdAt.toISOString(),
  }
}
