import { z } from 'zod'
import { INotificationDocument } from './notification.model'
import { notificationResponseSchema } from './notification.schema'

export type NotificationDto = z.infer<typeof notificationResponseSchema>

/**
 * Người đang đọc. `seenAt` là mốc "đã xem hộp thư tới đâu" của TỪNG nhóm, khoá theo
 * `organizationId` — xem `Membership.notificationsSeenAt`.
 */
export type NotificationViewer = {
  id: string
  seenAt: Map<string, Date | null>
}

/**
 * Document → DTO. Whitelist chứ không phải trả thẳng doc: `readBy` là danh sách id thành viên,
 * không được ra khỏi server (xem chú thích ở `notification.schema.ts`).
 *
 * `viewer` quyết định `isRead`, nên cùng một thông báo trả về khác nhau cho hai người — đúng
 * bản chất "đã đọc" là quan hệ giữa người và thông báo, không phải thuộc tính của thông báo.
 */
export function toNotificationDto(
  doc: INotificationDocument,
  viewer: NotificationViewer,
): NotificationDto {
  return {
    id: doc._id.toString(),
    organizationId: doc.organizationId ? doc.organizationId.toString() : null,
    unitId: doc.unitId ? doc.unitId.toString() : null,
    actorName: doc.actorName || undefined,
    listingId: doc.listingId ? doc.listingId.toString() : null,
    title: doc.title,
    body: doc.body,
    isRead: isReadBy(doc, viewer),
    readCount: doc.readBy.length,
    createdAt: doc.createdAt.toISOString(),
  }
}

/**
 * Hai cơ chế "đã đọc", chọn theo `actorId` — xem `readBy` trong `notification.model.ts`.
 *
 * - Dòng do NGƯỜI soạn (`actorId: null`): tra `readBy`. Ít dòng, và quản trị cần `readCount`.
 * - Dòng SINH TỰ ĐỘNG (`actorId` khác null): so `createdAt` với mốc của nhóm. Không ghi gì lúc
 *   đọc, nên `readBy` không phình theo số thành viên.
 *
 * Chưa có mốc (`null` — chưa mở hộp thư lần nào) thì mọi dòng tự động là CHƯA đọc. Không rơi
 * về `true`: một hộp thư mới toanh mà đã đánh dấu đọc hết là thứ khiến người dùng bỏ qua nó
 * mãi mãi.
 */
function isReadBy(doc: INotificationDocument, viewer: NotificationViewer): boolean {
  if (!doc.actorId) return doc.readBy.some((id) => id.toString() === viewer.id)

  const seen = doc.organizationId ? viewer.seenAt.get(doc.organizationId.toString()) : null
  return seen != null && doc.createdAt <= seen
}
