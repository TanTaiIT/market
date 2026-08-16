import { Types } from 'mongoose'
import { Notification, INotification } from './notification.model'
import { PaginationParams } from '../../common/utils/pagination'

/** Phạm vi đọc. `all` bỏ qua `units`; `units` rỗng = chỉ thông báo gửi cho cả tổ chức. */
export type NotificationAudience = { all?: boolean; units?: Types.ObjectId[] }

export const notificationRepository = {
  create(data: Partial<INotification>) {
    return Notification.create(data)
  },

  /**
   * `all` = bỏ hẳn điều kiện nhóm. Ngược lại luôn có nhánh `unitId: null` (thông báo cả tổ
   * chức) và chỉ thêm `$in` khi danh sách nhóm không rỗng — `$in: []` khớp 0 document, nên
   * thêm vô điều kiện sẽ biến "không thuộc nhóm nào" thành "không thấy gì cả".
   */
  async paginate(audience: NotificationAudience, { skip, limit }: PaginationParams) {
    const filter = audience.all
      ? {}
      : audience.units?.length
        ? { $or: [{ unitId: null }, { unitId: { $in: audience.units } }] }
        : { unitId: null }

    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
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
