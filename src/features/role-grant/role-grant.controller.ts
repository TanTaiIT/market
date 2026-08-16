import { roleGrantService } from './role-grant.service'
import { roleGrantRepository } from './role-grant.repository'
import { toRoleGrantDto } from './role-grant.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const roleGrantController = {
  // POST /role-grants
  grant: catchAsync(async (req, res) => {
    const data = await roleGrantService.grant(req.user!.id, req.body)
    created(res, { message: 'Đã cấp quyền', data })
  }),

  // DELETE /role-grants/:id
  revoke: catchAsync(async (req, res) => {
    const data = await roleGrantService.revoke(req.user!.id, req.params.id)
    success(res, { message: 'Đã thu hồi quyền', data })
  }),

  // GET /role-grants/mine
  mine: catchAsync(async (req, res) => {
    const docs = await roleGrantRepository.listActiveByUser(req.user!.id)
    success(res, { message: 'Quyền của tôi', data: docs.map(toRoleGrantDto) })
  }),
}
