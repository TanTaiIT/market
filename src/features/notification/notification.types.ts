import { z } from 'zod'
import { INotificationDocument } from './notification.model'
import { notificationResponseSchema } from './notification.schema'

export type NotificationDto = z.infer<typeof notificationResponseSchema>

/**
 * Document → DTO. Whitelist chứ không phải trả thẳng doc: `readBy` là danh sách id thành viên,
 * không được ra khỏi server (xem chú thích ở `notification.schema.ts`).
 *
 * `viewerId` quyết định `isRead`, nên cùng một thông báo trả về khác nhau cho hai người — đúng
 * bản chất "đã đọc" là quan hệ giữa người và thông báo, không phải thuộc tính của thông báo.
 */
export function toNotificationDto(doc: INotificationDocument, viewerId: string): NotificationDto {
  return {
    id: doc._id.toString(),
    organizationId: doc.organizationId.toString(),
    unitId: doc.unitId ? doc.unitId.toString() : null,
    title: doc.title,
    body: doc.body,
    isRead: doc.readBy.some((id) => id.toString() === viewerId),
    readCount: doc.readBy.length,
    createdAt: doc.createdAt.toISOString(),
  }
}
