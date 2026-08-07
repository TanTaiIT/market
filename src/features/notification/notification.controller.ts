import { notificationService } from './notification.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const notificationController = {
  // GET /notifications
  list: catchAsync(async (req, res) => {
    const { items, meta } = await notificationService.list(req.query as never)
    success(res, { message: 'Notifications', data: items, meta })
  }),

  // POST /notifications
  create: catchAsync(async (req, res) => {
    const notification = await notificationService.createForOrganization(req.body)
    created(res, { message: 'Notification sent', data: notification })
  }),

  // PATCH /notifications/:id/read
  markRead: catchAsync(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id, req.user!.id)
    success(res, { message: 'Notification marked as read', data: notification })
  }),
}
