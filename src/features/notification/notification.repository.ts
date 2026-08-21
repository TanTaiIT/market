import { FilterQuery, Types } from 'mongoose'
import { Notification, INotification, INotificationDocument } from './notification.model'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * Phạm vi đọc. `all` bỏ qua `units`; `units` rỗng = chỉ thông báo gửi cho cả tổ chức.
 * `recipientId` kèm thêm thông báo ĐÍCH DANH của người đó — vắng nó thì chỉ lấy tin phát chung.
 */
export type NotificationAudience = {
  all?: boolean
  units?: Types.ObjectId[]
  recipientId?: Types.ObjectId
}

/**
 * Vế thông báo PHÁT CHUNG. `userId: null` là điều kiện bắt buộc ở mọi nhánh: thiếu nó thì bàn
 * quản trị (`scope=managed`) đọc luôn thông báo riêng của từng người trong tổ chức.
 */
function broadcastFilter(audience: NotificationAudience): FilterQuery<INotificationDocument> {
  if (audience.all) return { userId: null }

  // `$in: []` khớp 0 document, nên chỉ thêm nhánh nhóm khi danh sách không rỗng — thêm vô điều
  // kiện sẽ biến "không thuộc nhóm nào" thành "không thấy gì cả".
  if (audience.units?.length) {
    return { userId: null, $or: [{ unitId: null }, { unitId: { $in: audience.units } }] }
  }
  return { userId: null, unitId: null }
}

export const notificationRepository = {
  create(data: Partial<INotification>) {
    return Notification.create(data)
  },

  /**
   * Thông báo hệ thống gửi cho một người, ví dụ "tin của bạn bị từ chối".
   *
   * `runUnscoped` + khai `organizationId` tường minh vì nó phải rơi vào org của ĐỐI TƯỢNG, không
   * phải org của người thao tác: một master duyệt tin hộ một trường khác thì scope mang org của
   * master, mà plugin lại GHI ĐÈ `organizationId` theo scope — thông báo sẽ nằm ở org của master
   * và người đăng không bao giờ thấy.
   */
  createForUser(input: {
    organizationId: Types.ObjectId
    userId: Types.ObjectId
    title: string
    body: string
  }) {
    return runUnscoped('system notification lands in the SUBJECT org, not the actor org', () =>
      Notification.create({ ...input, unitId: null }),
    )
  },

  async paginate(audience: NotificationAudience, { skip, limit }: PaginationParams) {
    const broadcast = broadcastFilter(audience)
    const filter: FilterQuery<INotificationDocument> = audience.recipientId
      ? { $or: [{ userId: audience.recipientId }, broadcast] }
      : broadcast

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
