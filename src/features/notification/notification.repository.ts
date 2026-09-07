import { FilterQuery, Types } from 'mongoose'
import { Notification, INotification, INotificationDocument } from './notification.model'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * Một nhóm mà người đọc ĐỨNG TRONG, kèm nhóm con của họ trong đúng nhóm đó.
 *
 * `unitId` phải đi cùng `organizationId` chứ không gom thành một danh sách phẳng: người ta ở
 * lớp 10A1 của trường A và phòng Kỹ thuật của công ty B, mà một danh sách unit chung sẽ cho họ
 * đọc thông báo gửi riêng cho 10A1 khi đang xét quyền ở công ty B.
 */
export type InboxGroup = {
  organizationId: Types.ObjectId
  unitId: Types.ObjectId | null
  /** Vào nhóm từ khi nào — thông báo có trước mốc này không phải việc của họ. */
  joinedAt: Date
}

/**
 * Hộp thư của MỘT người: thông báo đích danh + thông báo phát chung của mọi nhóm họ tham gia.
 *
 * Bản trước chỉ nhận đúng một `organizationId` — org đang thao tác của request. Người thuộc ba
 * nhóm vì thế chỉ đọc được hộp thư của một nhóm, và người KHÔNG có org đang thao tác (đa số:
 * ai thuộc từ hai nhóm trở lên) không đọc được nhánh phát chung nào cả.
 */
export type InboxAudience = {
  recipientId: Types.ObjectId
  groups: InboxGroup[]
}

/** Bàn quản trị: thứ mình GỬI được, luôn trong đúng một org. `all` bỏ điều kiện nhóm con. */
export type ManagedAudience = {
  organizationId: Types.ObjectId | null
  all?: boolean
  units?: Types.ObjectId[]
}

/**
 * Vế phát chung của hộp thư: `$or` một nhánh cho mỗi nhóm.
 *
 * `userId: null` là điều kiện bắt buộc — thiếu nó thì đọc luôn thông báo đích danh của người
 * khác trong cùng nhóm.
 *
 * `createdAt: { $gte: joinedAt }` cho từng nhóm: người vào nhóm hôm nay không nhận cả lịch sử
 * thông báo của nhóm đó. Ràng theo TỪNG nhóm chứ không một mốc chung, vì họ vào ba nhóm ở ba
 * thời điểm khác nhau.
 */
function inboxBroadcastBranches(groups: InboxGroup[]): FilterQuery<INotificationDocument>[] {
  return groups.map((g) => ({
    organizationId: g.organizationId,
    userId: null,
    createdAt: { $gte: g.joinedAt },
    // Thông báo gửi cho cả nhóm (`unitId: null`), cộng thông báo gửi riêng nhóm con của họ.
    ...(g.unitId ? { $or: [{ unitId: null }, { unitId: g.unitId }] } : { unitId: null }),
  }))
}

function managedFilter(audience: ManagedAudience): FilterQuery<INotificationDocument> {
  // `organizationId` khai TƯỜNG MINH: model đã ra khỏi `tenantPlugin` nên không còn ai chèn
  // filter hộ, mà thông báo phát chung thì vẫn của riêng một tổ chức.
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

  /**
   * Hộp thư. Nhánh đích danh KHÔNG kèm `organizationId`: hộp thư của một người là MỘT hộp thư,
   * không phải một cái cho mỗi tổ chức họ tham gia.
   *
   * `actorId: { $ne: recipientId }` áp cho CẢ hai nhánh, và đó là chỗ giải bài "đừng báo cho
   * chính người vừa làm": phát chung không có danh sách người nhận để trừ ai ra, nhưng có tác
   * giả để loại. Thông báo do hệ thống sinh (`actorId: null`) không bị điều kiện này chạm tới —
   * `$ne` khớp cả document mang `null`.
   */
  async paginateInbox(audience: InboxAudience, { skip, limit }: PaginationParams) {
    const branches: FilterQuery<INotificationDocument>[] = [
      { userId: audience.recipientId },
      ...inboxBroadcastBranches(audience.groups),
    ]

    const filter: FilterQuery<INotificationDocument> = {
      $or: branches,
      actorId: { $ne: audience.recipientId },
    }

    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ])
    return { items, total }
  },

  /** Bàn quản trị — thứ người gọi có quyền gửi tới, trong đúng một org. */
  async paginateManaged(audience: ManagedAudience, { skip, limit }: PaginationParams) {
    const filter = managedFilter(audience)
    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ])
    return { items, total }
  },

  findById(id: string) {
    return Notification.findById(id).exec()
  },

  markRead(id: string, userId: Types.ObjectId) {
    return Notification.findOneAndUpdate(
      { _id: id },
      { $addToSet: { readBy: userId } },
      { new: true },
    ).exec()
  },
}
