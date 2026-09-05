import { Types } from 'mongoose'
import { Conversation, Message, IConversation, IMessage } from './chat.model'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * KHÔNG có tầng lọc tenant nào dưới file này — `Conversation` đã bỏ `tenantPlugin`
 * (xem `chat.model.ts`). Hệ quả phải nhớ khi sửa ở đây: các hàm dưới trả về đúng những gì
 * filter viết ra, không có lưới nào đỡ phía sau.
 *
 * Vì vậy MỌI hàm nhận `id` của một hội thoại đều giả định người gọi đã đi qua
 * `requireMembership` ở `chat.service` — đó là chốt quyền duy nhất. Thêm một hàm mới ở đây mà
 * quên bước đó là mở đường đọc hội thoại của người lạ bằng cách đoán id.
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
   * Xoá avatar snapshot bị máy kiểm ảnh từ chối (webhook `moderation.webhook.service.ts`).
   * `arrayFilters` vì một hội thoại có nhiều participant — chỉ phần tử khớp mới bị xoá.
   *
   * Không còn bọc `runUnscoped`: nó từng cần để vượt qua `tenantPlugin` cho một sự kiện không
   * thuộc org nào. Plugin đã gỡ, nên bọc thêm chỉ là hứa hẹn sai về một hàng rào không có.
   */
  async clearParticipantAvatarRef(pattern: RegExp): Promise<number> {
    const res = await Conversation.updateMany(
      { 'participants.avatar': pattern },
      { $set: { 'participants.$[p].avatar': '' } },
      { arrayFilters: [{ 'p.avatar': pattern }] },
    ).exec()
    return res.modifiedCount
  },

  /**
   * Avatar snapshot của người tham gia mọi hội thoại — cho job dọn ảnh mồ côi
   * (`upload.cleanup.service.ts`). Snapshot chụp lúc mở hội thoại (§2.3 cấm populate), nên nó
   * có thể là chủ CUỐI CÙNG của một ảnh mà user đã đổi từ lâu — thiếu nguồn này là job giật
   * ảnh ngay trong khung chat.
   */
  async allConversationAvatars(): Promise<string[]> {
    const rows = await Conversation.find().select('participants.avatar').lean().exec()
    return rows.flatMap((r) => r.participants.map((p) => p.avatar)).filter(Boolean)
  },
}
