import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { NOTIFICATION_SOURCE, NotificationSource } from '../../common/constants'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

export interface INotification {
  organizationId: Types.ObjectId
  /** Nguồn phát sinh — chỉ để hiển thị/audit, KHÔNG dùng để mở rộng quyền đọc. */
  sourceType: NotificationSource
  sourceChainId: Types.ObjectId | null
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
    sourceType: {
      type: String,
      enum: Object.values(NOTIFICATION_SOURCE),
      default: NOTIFICATION_SOURCE.ORGANIZATION,
    },
    sourceChainId: { type: Schema.Types.ObjectId, ref: 'Chain', default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    // ponytail: mảng trong document — đủ cho vài nghìn user/org; tách bảng
    // NotificationRead khi cần biết ai đọc lúc nào hoặc org vượt kích thước document.
    readBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
)

// chainReadable: false — thông báo cấp chain KHÔNG mở rộng quyền đọc mà được nhân bản sẵn
// mỗi org một bản (notification.service.createForChain). Nhờ vậy tenantPlugin không cần
// ngoại lệ nào ngoài Listing, và trạng thái đã đọc tự tách theo từng org.
notificationSchema.plugin(tenantPlugin)

notificationSchema.index({ organizationId: 1, createdAt: -1 })

export const Notification: Model<INotificationDocument> = mongoose.model<INotificationDocument>(
  'Notification',
  notificationSchema,
)
