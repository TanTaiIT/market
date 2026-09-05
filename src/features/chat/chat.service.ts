import { Types } from 'mongoose'
import { chatRepository } from './chat.repository'
import { ConversationQuery, OpenConversationInput, SendMessageInput } from './chat.schema'
import { toConversationDto, toMessageDto } from './chat.types'
import { IConversationDocument } from './chat.model'
import { listingService } from '../listing/listing.service'
import { userRepository } from '../user/user.repository'
import { BadRequestError, NotFoundError } from '../../common/errors'
import { PUBLIC_LISTING_STATUSES } from '../../common/constants'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'
import { emitToConversation } from '../../sockets/emit'

/**
 * CHỈ có danh tính, không kèm org.
 *
 * Quyền trong chat đến từ QUAN HỆ (`participants`), không từ tenant — xem `chat.model.ts`.
 * Nhét `organizationId` vào đây là mời người sau dùng nó làm chốt quyền lần nữa.
 */
export interface ChatActor {
  id: string
}

/**
 * Ai không phải thành viên thì nhận **404**, không phải 403 — 403 là xác nhận hội thoại đó
 * có tồn tại (convention §8).
 *
 * Đây giờ là chốt quyền DUY NHẤT của cả feature, sau khi `tenantPlugin` được gỡ khỏi
 * `Conversation`. Trước đây nó là lớp thứ hai nên sửa nhầm cũng còn lớp dưới đỡ; giờ thì không.
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

    /*
     * KHÔNG kiểm org nữa — nhắn cho người đăng tin không đòi phải cùng nhóm, cũng không đòi
     * phải thuộc nhóm nào.
     *
     * Chốt thay thế đã nằm sẵn ở dòng `getById` phía trên và nó chặt hơn: `Listing` vẫn gắn
     * `tenantPlugin` dual-axis, nên một tin NỘI BỘ của nhóm mình không thuộc về sẽ 404 ngay từ
     * lúc đọc — chưa tới được đây. Còn tin công khai thì ai đọc được cũng nhắn được, đúng như
     * mọi sàn rao vặt. Nói gọn: mở hội thoại được với đúng những tin mình XEM được.
     */
    if (listing.seller.toString() === actor.id) {
      throw new BadRequestError('Đây là tin của bạn')
    }

    const buyerId = new Types.ObjectId(actor.id)
    const existing = await chatRepository.findByListingAndBuyer(listing._id, buyerId)
    if (existing) return toConversationDto(existing, actor.id)

    const [buyer, seller] = await Promise.all([
      userRepository.findById(actor.id),
      userRepository.findById(listing.seller.toString()),
    ])
    if (!buyer) throw new NotFoundError('User not found')
    if (!seller) throw new NotFoundError('Người bán không còn tài khoản trong trường này')

    const conversation = await chatRepository.create({
      // Chụp lại nhóm của tin để còn biết hội thoại này đến từ bảng tin nào; `null` với tin
      // công khai. Chỉ để đọc — không call-site nào được dùng nó làm điều kiện truy cập.
      organizationId: listing.organizationId,
      listingId: listing._id,
      listingTitle: listing.title,
      // Ảnh ĐẦU, cùng ảnh mà thẻ tin trên bảng đang hiện — để người dùng nhận ra ngay đây là
      // món đồ nào mà không phải đọc tiêu đề.
      listingImage: listing.images[0] ?? '',
      buyerId,
      sellerId: seller._id,
      participants: [
        { user: buyer._id, name: buyer.name, avatar: buyer.avatar, lastReadAt: new Date() },
        { user: seller._id, name: seller.name, avatar: seller.avatar, lastReadAt: null },
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
      clientMsgId: input.clientMsgId,
    })

    await chatRepository.touch(id, {
      text: input.text,
      senderId,
      at: message.createdAt,
    })
    // Người gửi vừa đọc chính tin của mình — không để hội thoại tự sáng đèn chưa đọc.
    await chatRepository.markRead(id, senderId)

    const dto = toMessageDto(message)
    emitToConversation(id, 'chat:message', dto)
    return dto
  },

  async markRead(id: string, actor: ChatActor) {
    await requireMembership(id, actor)
    const conversation = await chatRepository.markRead(id, new Types.ObjectId(actor.id))
    if (!conversation) throw new NotFoundError('Conversation not found')
    return toConversationDto(conversation, actor.id)
  },
}
