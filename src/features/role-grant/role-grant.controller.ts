import { roleGrantService } from './role-grant.service'
import { queryOf } from '../../middlewares/validate.middleware'
import { categoryAxisQuerySchema } from './role-grant.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const roleGrantController = {
  // POST /role-grants
  grant: catchAsync(async (req, res) => {
    const data = await roleGrantService.grant(req.user!.id, req.body)
    created(res, { message: 'Đã cấp quyền', data })
  }),

  // PATCH /role-grants/:id
  updateScope: catchAsync(async (req, res) => {
    const data = await roleGrantService.updateScope(req.user!.id, req.params.id, req.body)
    success(res, { message: 'Đã sửa phạm vi phụ trách', data })
  }),

  // DELETE /role-grants/:id
  revoke: catchAsync(async (req, res) => {
    const data = await roleGrantService.revoke(req.user!.id, req.params.id)
    success(res, { message: 'Đã thu hồi quyền', data })
  }),

  // GET /role-grants/category-axis
  categoryAxis: catchAsync(async (req, res) => {
    const data = await roleGrantService.listCategoryAxis(queryOf(req, categoryAxisQuerySchema))
    success(res, { message: 'Phụ trách trục danh mục', data })
  }),

  // GET /role-grants/mine
  mine: catchAsync(async (req, res) => {
    success(res, { message: 'Quyền của tôi', data: await roleGrantService.listMine(req.user!.id) })
  }),
}
