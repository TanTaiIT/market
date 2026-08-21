import { reportService } from './report.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { orgActor } from '../../common/utils/actor'
import { success, created } from '../../common/utils/apiResponse'

export const reportController = {
  // POST /reports
  create: catchAsync(async (req, res) => {
    const report = await reportService.create(req.body, orgActor(req, 'report.create'))
    created(res, { message: 'Report submitted', data: report })
  }),

  // GET /reports
  list: catchAsync(async (req, res) => {
    const { items, meta } = await reportService.list(req.query as never)
    success(res, { message: 'Reports', data: items, meta })
  }),

  // PATCH /reports/:id
  resolve: catchAsync(async (req, res) => {
    const report = await reportService.resolve(req.params.id, req.body, {
      ...orgActor(req, 'report.resolve'),
      grants: req.grants!,
    })
    success(res, { message: 'Report resolved', data: report })
  }),
}
