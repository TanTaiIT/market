import { Types } from 'mongoose'
import { Notification, INotification } from './notification.model'
import { PaginationParams } from '../../common/utils/pagination'
import { runUnscoped } from '../../common/tenant/tenantContext'

export const notificationRepository = {
  create(data: Partial<INotification>) {
    return Notification.create(data)
  },

  /**
   * Nhân bản một thông báo ra nhiều org. Ghi luôn bị ép về org của chính request, nên
   * fan-out phải chạy unscoped và tự mang organizationId trên từng document.
   */
  fanOut(rows: Partial<INotification>[]) {
    return runUnscoped('chain notification fan-out', () => Notification.insertMany(rows))
  },

  async paginate({ skip, limit }: PaginationParams) {
    const [items, total] = await Promise.all([
      Notification.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(),
    ])
    return { items, total }
  },

  markRead(id: string, userId: Types.ObjectId) {
    return Notification.findOneAndUpdate(
      { _id: id },
      { $addToSet: { readBy: userId } },
      { new: true },
    ).exec()
  },
}
