import { metricsService } from './metrics.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const metricsController = {
  // GET /metrics/system
  system: catchAsync(async (_req, res) => {
    const data = await metricsService.system()
    success(res, { message: 'System metrics', data })
  }),
}
