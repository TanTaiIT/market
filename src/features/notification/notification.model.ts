import mongoose, { Schema, Document, Model, Types } from 'mongoose'

export interface INotification {
  /**
   * Org phát ra thông báo này. `null` = việc xảy ra ngoài mọi tổ chức — tin trên trục danh mục
   * được duyệt, lời mời từ một org mà người nhận chưa thuộc về.
   */
  organizationId: Types.ObjectId | null
  /**
   * Người nhận ĐÍCH DANH. `null` = thông báo phát chung cho tổ chức/nhóm con như trước.
   *
   * Có mặt vì trước đây model chỉ có `organizationId` + `unitId`, tức chỉ phát được theo nhóm.
   * Mọi sự kiện thuộc về MỘT người — tin bị từ chối kèm lý do, đơn xin vào org được duyệt —
   * không có chỗ đáp: lý do từ chối nằm im trong `listing.moderation.reason` và người đăng
   * phải tự mở tin ra mới biết.
   */
  userId: Types.ObjectId | null
  /**
   * Nhóm con nhận thông báo. `null` = cả tổ chức.
   *
   * Có mặt vì quyền duyệt trong org vốn đã phân tầng (§7.2a): `staff` scope `org_unit` chỉ với
   * tới nhóm của mình. Thiếu cột này thì họ vẫn `POST /notifications` được và chạm tới toàn bộ
   * tổ chức — rộng hơn hẳn phạm vi được cấp.
   */
  unitId: Types.ObjectId | null
  title: string
  body: string
  readBy: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

export interface INotificationDocument extends INotification, Document {
  _id: Types.ObjectId
}

const notificationSchema = new Schema<INotificationDocument>(
  {
    /*
     * Khai TƯỜNG MINH, vì `tenantPlugin` không còn thêm nó hộ nữa.
     *
     * Đây là cái bẫy của việc gỡ plugin: interface vẫn khai `organizationId` nên TypeScript im
     * lặng, nhưng Mongoose vứt mọi field không có trong schema lúc ghi — thông báo phát chung
     * lưu xuống mất org, và không ai đọc lại được nó. Test bắt được, typecheck thì không.
     */
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    // ponytail: mảng trong document — đủ cho vài nghìn user/org; tách bảng
    // NotificationRead khi cần biết ai đọc lúc nào hoặc org vượt kích thước document.
    readBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
)

/*
 * KHÔNG gắn `tenantPlugin` — hộp thư thuộc về NGƯỜI NHẬN, không thuộc tổ chức.
 *
 * Bản trước gắn plugin và `organizationId` bắt buộc, nên toàn bộ trục danh mục không có thông
 * báo nào: tin công khai có `organizationId: null`, `notifyUser` lặng lẽ trả `null`, và người
 * đăng không bao giờ biết tin mình được duyệt hay bị từ chối. Người thuộc hai org cũng chỉ đọc
 * được hộp thư của org đang chọn.
 *
 * Cách ly không vì thế mà thủng: nhánh PHÁT CHUNG (`userId: null`) vẫn lọc `organizationId`
 * tường minh theo org của request — xem `broadcastFilter`. Chỉ thông báo đích danh mới đi
 * theo người.
 */

// `createdAt` đứng TRƯỚC `unitId`/`userId` dù hai cái sau mới là thứ được lọc: đường đọc phổ
// biến nhất (`scope=managed` của quản lý cấp org) chỉ ràng `organizationId` rồi sort
// `createdAt`. Xếp chúng chen vào giữa thì index không phục vụ được sort đó nữa và Mongo phải
// sort trong bộ nhớ. Ở thứ tự này MỌI đường đọc dùng chung một index: `organizationId` cho
// bounds, `createdAt` cho thứ tự, còn `unitId`/`userId` lọc ngay trên khoá index (không fetch).
notificationSchema.index({ organizationId: 1, createdAt: -1, unitId: 1, userId: 1 })

// Hộp thư ĐÍCH DANH: nhánh này giờ không còn ràng `organizationId` nên index trên không phục
// vụ nó — thiếu dòng dưới thì mỗi lần mở màn thông báo là một lượt quét cả bảng.
notificationSchema.index({ userId: 1, createdAt: -1 })

export const Notification: Model<INotificationDocument> = mongoose.model<INotificationDocument>(
  'Notification',
  notificationSchema,
)
