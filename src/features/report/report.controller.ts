import { reportService } from './report.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { moderatorActor } from '../../common/utils/actor'
import { success, created } from '../../common/utils/apiResponse'

export const reportController = {
  // POST /reports — `moderatorActor` (chỉ `id`), không phải `orgActor`: trục của báo cáo lấy từ
  // ĐỐI TƯỢNG bị tố, và người tố có thể không thuộc org nào (khách của trục công khai).
  create: catchAsync(async (req, res) => {
    const report = await reportService.create(req.body, moderatorActor(req))
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
      ...moderatorActor(req),
      grants: req.grants!,
    })
    success(res, { message: 'Report resolved', data: report })
  }),
}
