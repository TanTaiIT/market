import { orgUnitService } from './org-unit.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const orgUnitController = {
  // GET /org-units
  list: catchAsync(async (_req, res) => {
    const data = await orgUnitService.list()
    success(res, { message: 'Danh sách nhóm con', data })
  }),

  // POST /org-units
  create: catchAsync(async (req, res) => {
    const data = await orgUnitService.create(req.body)
    created(res, { message: 'Đã tạo nhóm con', data })
  }),

  // PATCH /org-units/:id
  update: catchAsync(async (req, res) => {
    const data = await orgUnitService.update(req.params.id, req.body)
    success(res, { message: 'Đã cập nhật nhóm con', data })
  }),

  // DELETE /org-units/:id
  remove: catchAsync(async (req, res) => {
    const data = await orgUnitService.remove(req.params.id)
    success(res, { message: 'Đã xoá nhóm con', data })
  }),
}
