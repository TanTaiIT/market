import { Types } from 'mongoose'
import { chatRepository } from './chat.repository'
import { ConversationQuery, OpenConversationInput, SendMessageInput } from './chat.schema'
import { toConversationDto, toMessageDto } from './chat.types'
import { IConversationDocument } from './chat.model'
import { listingService } from '../listing/listing.service'
import { userRepository } from '../user/user.repository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors'
import { PUBLIC_LISTING_STATUSES } from '../../common/constants'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'
import { emitToConversation } from '../../sockets/emit'

export interface ChatActor {
  id: string
  organizationId: string
}

/**
 * Ai không phải thành viên thì nhận **404**, không phải 403 — 403 là xác nhận hội thoại đó
 * có tồn tại (convention §8). Hội thoại của org khác đã bị `tenantPlugin` loại từ tầng dưới
 * nên cũng rơi vào đúng nhánh này.
 */
async function requireMembership(id: string, actor: ChatActor): Promise<IConversationDocument> {
  const conversation = await chatRepository.findById(id)
  if (!conversation) throw new NotFoundError('Conversation not found')

  const isMember = conversation.participants.some((p) => p.user.toString() === actor.id)
  if (!isMember) throw new NotFoundError('Conversation not found')

  return conversation
}

export const chatService = {
  /**
   * Mở hội thoại cho một tin, hoặc trả lại hội thoại đã có. Bấm "Nhắn tin" lần thứ hai không
   * đẻ thêm bản ghi — unique index `(organizationId, listingId, buyerId)` là chốt cuối.
   */
  async open(input: OpenConversationInput, actor: ChatActor) {
    const listing = await listingService.getById(input.listingId)

    // Tin chưa duyệt / đã từ chối / đang ẩn thì không mở hội thoại được. Trả 404 chứ không
    // 403: 403 là xác nhận tin đó có tồn tại, đúng thứ `PUBLIC_LISTING_STATUSES` sinh ra để giấu.
    if (!PUBLIC_LISTING_STATUSES.includes(listing.status)) {
      throw new NotFoundError('Listing not found')
    }

    // Listing bật `chainReadable` nên tin trả về có thể thuộc trường khác trong cùng hệ thống.
    // Chat thì chưa mở xuyên trường, và người bán bên đó cũng không nằm trong org của mình để
    // đọc tên — chặn ở đây với thông điệp đúng nguyên nhân.
    if (listing.organizationId.toString() !== actor.organizationId) {
      throw new ForbiddenError('Chưa nhắn tin được với người bán ở trường khác')
    }
    if (listing.seller.toString() === actor.id) {
      throw new BadRequestError('Đây là tin của bạn')
    }

    const buyerId = new Types.ObjectId(actor.id)
    const existing = await chatRepository.findByListingAndBuyer(listing._id, buyerId)
    if (existing) return toConversationDto(existing, actor.id)

    const [buyer, seller] = await Promise.all([
      userRepository.findById(actor.id, actor.organizationId),
      userRepository.findById(listing.seller.toString(), actor.organizationId),
    ])
    if (!buyer) throw new NotFoundError('User not found')
    if (!seller) throw new NotFoundError('Người bán không còn tài khoản trong trường này')

    const conversation = await chatRepository.create({
      listingId: listing._id,
      listingTitle: listing.title,
      buyerId,
      sellerId: seller._id,
      participants: [
        { user: buyer._id, name: buyer.name, lastReadAt: new Date() },
        { user: seller._id, name: seller.name, lastReadAt: null },
      ],
      lastMessage: '',
      lastMessageAt: new Date(),
      lastSenderId: null,
    })

    return toConversationDto(conversation, actor.id)
  },

  async list(query: ConversationQuery, actor: ChatActor) {
    const pagination = parsePagination(query)
    const { items, total } = await chatRepository.paginateForUser(
      new Types.ObjectId(actor.id),
      pagination,
    )
    return {
      items: items.map((c) => toConversationDto(c, actor.id)),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  async getById(id: string, actor: ChatActor) {
    const conversation = await requireMembership(id, actor)
    return toConversationDto(conversation, actor.id)
  },

  async messages(id: string, query: ConversationQuery, actor: ChatActor) {
    await requireMembership(id, actor)

    const pagination = parsePagination(query)
    const { items, total } = await chatRepository.paginateMessages(id, pagination)
    return {
      items: items.map(toMessageDto),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Gửi tin nhắn. REST là đường ghi **duy nhất**: socket chỉ giao hàng.
   *
   * Cho client ghi thẳng qua socket sẽ thành hai đường ghi cho cùng một dữ liệu, và hai đường
   * thì sớm muộn phân quyền lệch nhau — chưa kể tin nhắn gửi lúc socket rớt sẽ mất trắng.
   */
  async send(id: string, input: SendMessageInput, actor: ChatActor) {
    const conversation = await requireMembership(id, actor)
    const me = conversation.participants.find((p) => p.user.toString() === actor.id)

    const senderId = new Types.ObjectId(actor.id)
    const message = await chatRepository.createMessage({
      conversationId: conversation._id,
      senderId,
      senderName: me?.name ?? '',
      text: input.text,
    })

    await chatRepository.touch(id, {
      text: input.text,
      senderId,
      at: message.createdAt,
    })
    // Người gửi vừa đọc chính tin của mình — không để hội thoại tự sáng đèn chưa đọc.
    await chatRepository.markRead(id, senderId)

    const dto = toMessageDto(message)
    emitToConversation(actor.organizationId, id, 'chat:message', dto)
    return dto
  },

  async markRead(id: string, actor: ChatActor) {
    await requireMembership(id, actor)
    const conversation = await chatRepository.markRead(id, new Types.ObjectId(actor.id))
    if (!conversation) throw new NotFoundError('Conversation not found')
    return toConversationDto(conversation, actor.id)
  },
}
