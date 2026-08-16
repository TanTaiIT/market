import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

export interface INotification {
  organizationId: Types.ObjectId
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
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    // ponytail: mảng trong document — đủ cho vài nghìn user/org; tách bảng
    // NotificationRead khi cần biết ai đọc lúc nào hoặc org vượt kích thước document.
    readBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
)

notificationSchema.plugin(tenantPlugin)

// `createdAt` đứng TRƯỚC `unitId` dù `unitId` mới là thứ được lọc: đường đọc phổ biến nhất
// (`scope=managed` của quản lý cấp org) chỉ ràng `organizationId` rồi sort `createdAt`. Xếp
// `unitId` chen vào giữa thì index không phục vụ được sort đó nữa và Mongo phải sort trong
// bộ nhớ. Ở thứ tự này cả hai đường đọc đều dùng chung một index.
notificationSchema.index({ organizationId: 1, createdAt: -1, unitId: 1 })

export const Notification: Model<INotificationDocument> = mongoose.model<INotificationDocument>(
  'Notification',
  notificationSchema,
)
