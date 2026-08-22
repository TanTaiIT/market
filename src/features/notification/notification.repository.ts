import { FilterQuery, Types } from 'mongoose'
import { Notification, INotification, INotificationDocument } from './notification.model'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * Phạm vi đọc. `all` bỏ qua `units`; `units` rỗng = chỉ thông báo gửi cho cả tổ chức.
 * `recipientId` kèm thêm thông báo ĐÍCH DANH của người đó — vắng nó thì chỉ lấy tin phát chung.
 */
export type NotificationAudience = {
  /** Org của request — chỉ ràng nhánh PHÁT CHUNG. Thông báo đích danh đi theo người, không theo org. */
  organizationId: Types.ObjectId | null
  all?: boolean
  units?: Types.ObjectId[]
  recipientId?: Types.ObjectId
}

/**
 * Vế thông báo PHÁT CHUNG. `userId: null` là điều kiện bắt buộc ở mọi nhánh: thiếu nó thì bàn
 * quản trị (`scope=managed`) đọc luôn thông báo riêng của từng người trong tổ chức.
 */
function broadcastFilter(audience: NotificationAudience): FilterQuery<INotificationDocument> {
  // `organizationId` phải khai TƯỜNG MINH từ đây trở đi: model đã ra khỏi `tenantPlugin` nên
  // không còn ai chèn filter hộ, mà thông báo phát chung thì vẫn của riêng một tổ chức.
  const org = { organizationId: audience.organizationId }
  if (audience.all) return { ...org, userId: null }

  // `$in: []` khớp 0 document, nên chỉ thêm nhánh nhóm khi danh sách không rỗng — thêm vô điều
  // kiện sẽ biến "không thuộc nhóm nào" thành "không thấy gì cả".
  if (audience.units?.length) {
    return { ...org, userId: null, $or: [{ unitId: null }, { unitId: { $in: audience.units } }] }
  }
  return { ...org, userId: null, unitId: null }
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
    organizationId: Types.ObjectId | null
    userId: Types.ObjectId
    title: string
    body: string
  }) {
    return Notification.create({ ...input, unitId: null })
  },

  async paginate(audience: NotificationAudience, { skip, limit }: PaginationParams) {
    const broadcast = broadcastFilter(audience)
    // Nhánh đích danh KHÔNG kèm `organizationId`: đó là điểm của cả thay đổi này — hộp thư của
    // một người là một hộp thư, không phải một cái cho mỗi tổ chức họ tham gia.
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
