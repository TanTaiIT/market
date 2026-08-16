import { notificationService } from './notification.service'
import { toNotificationDto } from './notification.types'
import { roleGrantService } from '../role-grant/role-grant.service'
import { currentScope } from '../../common/tenant/tenantContext'
import { orgActor } from '../../common/utils/actor'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const notificationController = {
  // GET /notifications
  list: catchAsync(async (req, res) => {
    // Route này KHÔNG có `requireOrg`, và cố ý: v2 cho phép tài khoản không thuộc tổ chức nào
    // (người đăng tin công khai). Với họ, "chưa có thông báo" là câu trả lời đúng — ném lỗi
    // thiếu tổ chức sẽ biến một màn hình rỗng bình thường thành một màn hình hỏng.
    const organizationId = currentScope()?.ownOrgId
    if (!organizationId) {
      success(res, {
        message: 'Notifications',
        data: [],
        meta: buildPaginationMeta({ ...parsePagination(req.query as never), total: 0 }),
      })
      return
    }

    // Chỉ nạp grant khi thật sự cần: `inbox` quyết định phạm vi bằng membership, nạp grant cho
    // nó là một truy vấn thừa trên đúng đường đi nóng nhất của màn thông báo.
    const grants =
      (req.query as { scope?: string }).scope === 'managed'
        ? await roleGrantService.grantsOf(req.user!.id)
        : []

    const { items, meta } = await notificationService.list(req.query as never, {
      ...orgActor(req, 'notification.list'),
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
