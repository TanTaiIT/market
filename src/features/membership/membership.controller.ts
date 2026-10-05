import { membershipService } from './membership.service'
import { queryOf } from '../../middlewares/validate.middleware'
import { membershipQuerySchema } from './membership.schema'
import { roleGrantService } from '../role-grant/role-grant.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const membershipController = {
  // GET /memberships
  list: catchAsync(async (req, res) => {
    const { items, meta } = await membershipService.list(queryOf(req, membershipQuerySchema), {
      id: req.user!.id,
      grants: req.grants,
    })
    success(res, { message: 'Members', data: items, meta })
  }),

  // POST /memberships/leave
  leave: catchAsync(async (req, res) => {
    await membershipService.leave(req.user!.id)
    success(res, { message: 'Đã rời nhóm', data: null })
  }),

  // DELETE /memberships/:userId
  remove: catchAsync(async (req, res) => {
    await membershipService.remove(req.params.userId, {
      id: req.user!.id,
      grants: req.grants ?? (await roleGrantService.grantsOf(req.user!.id)),
    })
    success(res, { message: 'Đã gỡ khỏi nhóm', data: null })
  }),
}
