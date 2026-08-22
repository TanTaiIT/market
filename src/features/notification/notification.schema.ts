import { z } from 'zod'
import { registry } from '../../config/openapi'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const createNotificationSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    /**
     * Nhóm con nhận thông báo. Bỏ trống / `null` = cả tổ chức, và chỉ người quản lý cấp org
     * mới gửi được như vậy — staff của một nhóm bắt buộc phải ghi đúng nhóm của mình.
     */
    unitId: objectId.nullable().optional(),
  })
  .strict()
  .openapi('CreateNotification')

export const notificationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  /**
   * `inbox` (mặc định) = thứ TÔI nhận được. `managed` = thứ tôi có quyền gửi tới.
   *
   * Hai câu hỏi khác nhau và không bao hàm nhau: quản lý cấp org không thuộc nhóm nào nên
   * `inbox` của họ không chứa thông báo họ vừa gửi cho một nhóm — bàn quản trị mà đọc `inbox`
   * sẽ báo "đã gửi" rồi hiển thị một danh sách không có nó.
   *
   * Enum chứ không phải boolean: `z.coerce.boolean()` biến chuỗi "false" thành `true`.
   */
  scope: z.enum(['inbox', 'managed']).optional(),
})

export const notificationParamsSchema = z.object({ id: objectId })

/**
 * Whitelist, KHÔNG `passthrough` và KHÔNG `readBy`.
 *
 * Bản cũ trả nguyên document, nghĩa là mọi thành viên đọc thông báo đều nhận về danh sách id
 * của tất cả những người đã đọc nó — vừa lộ danh sách thành viên của tổ chức, vừa lộ ai đã
 * xem gì. Thứ client thật sự cần chỉ là hai con số dẫn xuất bên dưới.
 */
export const notificationResponseSchema = z
  .object({
    id: objectId,
    /** `null` = việc xảy ra ngoài mọi tổ chức (tin trên trục danh mục, lời mời từ org lạ). */
    organizationId: objectId.nullable(),
    /** `null` = gửi cho cả tổ chức. */
    unitId: objectId.nullable(),
    title: z.string(),
    body: z.string(),
    /** Chính người đang gọi đã đọc chưa — dẫn xuất từ `readBy`, không phải cột riêng. */
    isRead: z.boolean(),
    /** Số người đã đọc. Đây là con số CÓ THẬT duy nhất về độ phủ; không có "số người nhận". */
    readCount: z.number(),
    createdAt: z.string().datetime(),
  })
  .openapi('Notification')

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>
export type NotificationQuery = z.infer<typeof notificationQuerySchema>

registry.register('CreateNotification', createNotificationSchema)
registry.register('Notification', notificationResponseSchema)
