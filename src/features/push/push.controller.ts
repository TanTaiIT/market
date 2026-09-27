import { pushService } from './push.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const pushController = {
  // POST /push/devices
  register: catchAsync(async (req, res) => {
    const data = await pushService.registerDevice(req.user!.id, req.body)
    success(res, { message: 'Push device registered', data })
  }),

  // POST /push/devices/unregister
  unregister: catchAsync(async (req, res) => {
    await pushService.unregisterDevice(req.body.token)
    success(res, { message: 'Push device removed' })
  }),

  // GET /push/preferences
  preferences: catchAsync(async (req, res) => {
    const data = await pushService.preferences(req.user!.id)
    success(res, { message: 'Push preferences', data })
  }),

  // PATCH /push/preferences
  updatePreferences: catchAsync(async (req, res) => {
    const data = await pushService.updatePreferences(req.user!.id, req.body)
    success(res, { message: 'Push preferences updated', data })
  }),

  // POST /push/test
  test: catchAsync(async (req, res) => {
    const data = await pushService.sendTest(req.user!.id)
    success(res, { message: 'Push test queued', data })
  }),
}
