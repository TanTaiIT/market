import { Types } from 'mongoose'
import { ISupportMessage, ISupportThreadDocument, SupportThread } from './support.model'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * `SupportThread` KHÔNG mang `tenantPlugin` (xem docblock của model), nên repository này không
 * cần `runUnscoped` ở đâu cả — khác mọi repository còn lại của dự án.
 */
export const supportRepository = {
  findByUser(userId: string | Types.ObjectId): Promise<ISupportThreadDocument | null> {
    return SupportThread.findOne({ userId }).exec()
  },

  findById(id: string | Types.ObjectId): Promise<ISupportThreadDocument | null> {
    return SupportThread.findById(id).exec()
  },

  create(userId: Types.ObjectId) {
    return SupportThread.create({ userId })
  },

  /**
   * Nối một tin vào luồng và dời mốc thời gian của ĐÚNG phía vừa gửi.
   *
   * Một `findOneAndUpdate` thay vì đọc-sửa-ghi: hai thiết bị gửi cùng lúc thì `$push` của Mongo
   * giữ cả hai tin, còn đọc-sửa-ghi sẽ để tin sau đè mất tin trước.
   */
  appendMessage(
    id: Types.ObjectId,
    message: ISupportMessage,
    stamp: 'lastUserAt' | 'lastMasterAt',
  ) {
    return SupportThread.findByIdAndUpdate(
      id,
      { $push: { messages: message }, $set: { [stamp]: message.at } },
      { new: true },
    ).exec()
  },

  markRead(id: Types.ObjectId, field: 'userReadAt' | 'masterReadAt', at: Date) {
    return SupportThread.findByIdAndUpdate(id, { $set: { [field]: at } }, { new: true }).exec()
  },

  /**
   * Hàng đợi của master, luồng có tin người dùng mới nhất lên đầu.
   *
   * `messages` bị cắt khỏi kết quả: danh sách chỉ cần dòng cuối để xem trước, mà kéo cả lịch sử
   * của mọi luồng về là truyền hàng trăm KB cho một màn chỉ hiện vài chục dòng.
   */
  async paginateForMaster(
    onlyWaiting: boolean,
    { skip, limit }: PaginationParams,
  ): Promise<{ items: ISupportThreadDocument[]; total: number }> {
    // `$expr` vì điều kiện so sánh HAI FIELD của cùng document — `$gt` thường chỉ so với hằng.
    // `masterReadAt: null` là luồng chưa ai mở lần nào, cũng tính là đang chờ.
    const filter = onlyWaiting
      ? {
          lastUserAt: { $ne: null },
          $expr: { $gt: ['$lastUserAt', { $ifNull: ['$masterReadAt', new Date(0)] }] },
        }
      : {}

    const [items, total] = await Promise.all([
      SupportThread.find(filter)
        .select('-messages')
        .sort({ lastUserAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      SupportThread.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  /** Số luồng đang chờ master — con số cho badge của mục menu quản trị. */
  countWaiting(): Promise<number> {
    return SupportThread.countDocuments({
      lastUserAt: { $ne: null },
      $expr: { $gt: ['$lastUserAt', { $ifNull: ['$masterReadAt', new Date(0)] }] },
    }).exec()
  },
}
