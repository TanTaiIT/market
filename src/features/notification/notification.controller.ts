import { notificationService } from './notification.service'
import { queryOf } from '../../middlewares/validate.middleware'
import { notificationQuerySchema } from './notification.schema'
import { toNotificationDto } from './notification.types'
import { currentScope } from '../../common/tenant/tenantContext'
import { orgActor } from '../../common/utils/actor'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const notificationController = {
  // GET /notifications
  list: catchAsync(async (req, res) => {
    /*
     * Route này KHÔNG có `requireOrg`, và cố ý: phần lớn người dùng không thuộc tổ chức nào.
     *
     * Bản trước trả thẳng mảng rỗng cho họ. Giờ thì không: thông báo đích danh đi theo NGƯỜI,
     * nên người đăng tin trên trục danh mục vẫn phải biết tin mình được duyệt hay bị từ chối.
     * Chỉ nhánh phát chung mới cần org, và không có org thì đơn giản là không có nhánh đó.
     */
    const { items, meta } = await notificationService.list(queryOf(req, notificationQuerySchema), {
      id: req.user!.id,
      organizationId: currentScope()?.ownOrgId?.toString() ?? null,
      // Grant chỉ cần cho `scope=managed` — service tự nạp khi thiếu (audit 5.7).
      grants: req.grants,
    })
    success(res, { message: 'Notifications', data: items, meta })
  }),

  // POST /notifications
  create: catchAsync(async (req, res) => {
    const doc = await notificationService.createForOrganization(req.body, {
      ...orgActor(req, 'notification.create'),
      grants: req.grants!,
    })
    created(res, {
      message: 'Notification sent',
      data: toNotificationDto(doc, { id: req.user!.id, seenAt: new Map() }),
    })
  }),

  // PATCH /notifications/:id/read
  markRead: catchAsync(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id, req.user!.id)
    success(res, { message: 'Notification marked as read', data: notification })
  }),

  // DELETE /notifications
  clear: catchAsync(async (req, res) => {
    await notificationService.clearInbox(req.user!.id)
    success(res, { message: 'Notifications cleared', data: null })
  }),
}
