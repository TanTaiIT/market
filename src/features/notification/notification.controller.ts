import { notificationService } from './notification.service'
import { toNotificationDto } from './notification.types'
import { roleGrantService } from '../role-grant/role-grant.service'
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
    const organizationId = currentScope()?.ownOrgId ?? null

    // Chỉ nạp grant khi thật sự cần: `inbox` quyết định phạm vi bằng membership, nạp grant cho
    // nó là một truy vấn thừa trên đúng đường đi nóng nhất của màn thông báo.
    const grants =
      (req.query as { scope?: string }).scope === 'managed'
        ? await roleGrantService.grantsOf(req.user!.id)
        : []

    const { items, meta } = await notificationService.list(req.query as never, {
      id: req.user!.id,
      organizationId: organizationId?.toString() ?? null,
      grants,
    })
    success(res, { message: 'Notifications', data: items, meta })
  }),

  // POST /notifications
  create: catchAsync(async (req, res) => {
    const doc = await notificationService.createForOrganization(req.body, {
      ...orgActor(req, 'notification.create'),
      grants: req.grants!,
    })
    created(res, { message: 'Notification sent', data: toNotificationDto(doc, req.user!.id) })
  }),

  // PATCH /notifications/:id/read
  markRead: catchAsync(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id, req.user!.id)
    success(res, { message: 'Notification marked as read', data: notification })
  }),
}
