import { membershipService } from './membership.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const membershipController = {
  // GET /memberships
  list: catchAsync(async (req, res) => {
    const { items, meta } = await membershipService.list(req.query as never)
    success(res, { message: 'Members', data: items, meta })
  }),
}
