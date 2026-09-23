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

  /**
   * `$elemMatch` chứ không hai điều kiện rời (`'participants.user': me` + `'participants.hidden': false`):
   * hai điều kiện rời khớp document nào có MỘT phần tử mang `user` và MỘT phần tử khác mang
   * `hidden: false` — tức hội thoại tôi vừa xoá vẫn hiện, chỉ vì người kia chưa xoá.
   */
  async paginateForUser(userId: Types.ObjectId, { skip, limit }: PaginationParams) {
    const filter = { participants: { $elemMatch: { user: userId, hidden: false } } }
    const [items, total] = await Promise.all([
      Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).skip(skip).limit(limit),
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
  async paginateMessages(
    conversationId: string,
    { skip, limit }: PaginationParams,
    /** Mốc cắt của NGƯỜI ĐANG ĐỌC (`participants[].clearedAt`) — tin cũ hơn không còn là của họ. */
    after: Date | null = null,
  ) {
    const filter = {
      conversationId: new Types.ObjectId(conversationId),
      ...(after ? { createdAt: { $gt: after } } : {}),
    }
    const [items, total] = await Promise.all([
      Message.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
      Message.countDocuments(filter),
    ])
    return { items, total }
  },

  /**
   * Cập nhật phần tóm tắt sau khi có tin mới — danh sách hội thoại đọc thẳng từ đây.
   *
   * `participants.$[].hidden = false` gỡ ẩn cho CẢ HAI người, và đó là vế còn lại của tính năng
   * xoá hội thoại: người đã xoá thấy nó quay lại khi người kia nhắn tiếp. Không đụng tới
   * `clearedAt`, nên phần lịch sử họ đã xoá vẫn không hiện lại — chỉ tin từ lúc này trở đi.
   *
   * Đặt ở đây chứ không ở `send`: mọi đường ghi tin nhắn đều phải qua `touch` để cập nhật dòng
   * tóm tắt, nên đây là chỗ duy nhất không thể quên.
   */
  touch(conversationId: string, message: { text: string; senderId: Types.ObjectId; at: Date }) {
    return Conversation.findOneAndUpdate(
      { _id: conversationId },
      {
        $set: {
          lastMessage: message.text,
          lastSenderId: message.senderId,
          lastMessageAt: message.at,
          'participants.$[].hidden': false,
        },
      },
      { new: true },
    ).exec()
  },

  /**
   * Xoá hội thoại khỏi hộp thư của MỘT người: ẩn dòng, và cắt lịch sử tại thời điểm này.
   *
   * `participants.$` (positional) chỉ chạm phần tử khớp `'participants.user'` ở filter — người
   * kia không mất gì.
   */
  hideForUser(conversationId: string, userId: Types.ObjectId) {
    return Conversation.updateOne(
      { _id: conversationId, 'participants.user': userId },
      { $set: { 'participants.$.hidden': true, 'participants.$.clearedAt': new Date() } },
    ).exec()
  },

  /**
   * "Xoá tất cả" — cùng phép trên, áp cho mọi hội thoại người này còn thấy.
   *
   * `arrayFilters` thay vì `$` vì `updateMany` chạm nhiều document và vị trí phần tử khớp khác
   * nhau ở mỗi cái. Lọc sẵn `hidden: false` để không ghi đè `clearedAt` của những hội thoại họ
   * đã xoá từ trước — ghi đè sẽ đẩy mốc cắt lên hiện tại và nuốt thêm tin nhắn đến trong lúc ẩn.
   */
  async hideAllForUser(userId: Types.ObjectId): Promise<number> {
    const res = await Conversation.updateMany(
      { participants: { $elemMatch: { user: userId, hidden: false } } },
      { $set: { 'participants.$[me].hidden': true, 'participants.$[me].clearedAt': new Date() } },
      { arrayFilters: [{ 'me.user': userId }] },
    ).exec()
    return res.modifiedCount
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
    const rows = await Conversation.find().select('participants.avatar').lean().exec()
    return rows.flatMap((r) => r.participants.map((p) => p.avatar)).filter(Boolean)
  },
}
