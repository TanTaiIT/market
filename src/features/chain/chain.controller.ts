import { chainService } from './chain.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const chainController = {
  // GET /chains/:chainId/stats
  stats: catchAsync(async (req, res) => {
    const data = await chainService.stats(req.params.chainId)
    success(res, { message: 'Chain stats', data })
  }),

  // GET /chains/:chainId/organizations
  organizations: catchAsync(async (req, res) => {
    const data = await chainService.organizations(req.params.chainId)
    success(res, { message: 'Chain organizations', data })
  }),

  // POST /chains/:chainId/notifications
  broadcast: catchAsync(async (req, res) => {
    const data = await chainService.broadcast(req.params.chainId, req.body)
    created(res, { message: 'Notification fanned out to chain', data })
  }),
}
