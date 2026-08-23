import { Types } from 'mongoose'
import { Conversation, Message, IConversation, IMessage } from './chat.model'
import { PaginationParams } from '../../common/utils/pagination'
import { runUnscoped } from '../../common/tenant/tenantContext'

/**
 * Không có `organizationId` viết tay ở đâu trong file này — `tenantPlugin` chèn ở tầng dưới
 * (convention §2.1). Mọi hàm dưới đây đã tự động chỉ nhìn thấy dữ liệu của org trong scope.
 */
export const chatRepository = {
  create(data: Partial<IConversation>) {
    return Conversation.create(data)
  },

  findById(id: string) {
    return Conversation.findById(id)
  },

  /** Hội thoại đã có của cặp (tin, người mua) — dùng để bấm "Nhắn tin" lần hai không đẻ thêm. */
  findByListingAndBuyer(listingId: Types.ObjectId, buyerId: Types.ObjectId) {
    return Conversation.findOne({ listingId, buyerId })
  },

  async paginateForUser(userId: Types.ObjectId, { skip, limit }: PaginationParams) {
    const filter = { 'participants.user': userId }
    const [items, total] = await Promise.all([
      Conversation.find(filter).sort({ lastMessageAt: -1 }).skip(skip).limit(limit),
      Conversation.countDocuments(filter),
    ])
    return { items, total }
  },

  createMessage(data: Partial<IMessage>) {
    return Message.create(data)
  },

  /**
   * Lịch sử tin nhắn, mới nhất trước — client tự đảo lại khi render. Phân trang theo chiều
   * này mới đúng: người dùng mở hội thoại là muốn thấy phần cuối, không phải phần đầu.
   */
  async paginateMessages(conversationId: string, { skip, limit }: PaginationParams) {
    const filter = { conversationId: new Types.ObjectId(conversationId) }
    const [items, total] = await Promise.all([
      Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Message.countDocuments(filter),
    ])
    return { items, total }
  },

  /** Cập nhật phần tóm tắt sau khi có tin mới — danh sách hội thoại đọc thẳng từ đây. */
  touch(conversationId: string, message: { text: string; senderId: Types.ObjectId; at: Date }) {
    return Conversation.findOneAndUpdate(
      { _id: conversationId },
      { lastMessage: message.text, lastSenderId: message.senderId, lastMessageAt: message.at },
      { new: true },
    ).exec()
  },

  markRead(conversationId: string, userId: Types.ObjectId) {
    return Conversation.findOneAndUpdate(
      { _id: conversationId, 'participants.user': userId },
      { $set: { 'participants.$.lastReadAt': new Date() } },
      { new: true },
    ).exec()
  },

  /**
   * Avatar snapshot của người tham gia mọi hội thoại — cho job dọn ảnh mồ côi
   * (`upload.cleanup.service.ts`). Snapshot chụp lúc mở hội thoại (§2.3 cấm populate), nên nó
   * có thể là chủ CUỐI CÙNG của một ảnh mà user đã đổi từ lâu — thiếu nguồn này là job giật
   * ảnh ngay trong khung chat.
   */
  async allConversationAvatars(): Promise<string[]> {
    const rows = await runUnscoped('image cleanup: gom avatar snapshot của mọi hội thoại', () =>
      Conversation.find().select('participants.avatar').lean().exec(),
    )
    return rows.flatMap((r) => r.participants.map((p) => p.avatar)).filter(Boolean)
  },
}
