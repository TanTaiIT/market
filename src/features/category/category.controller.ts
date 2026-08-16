import { categoryService } from './category.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const categoryController = {
  // GET /categories
  list: catchAsync(async (req, res) => {
    const categories = await categoryService.list(req.query as never)
    success(res, { message: 'Categories', data: categories })
  }),

  // GET /categories/:id
  getById: catchAsync(async (req, res) => {
    const category = await categoryService.getById(req.params.id)
    success(res, { message: 'Category detail', data: category })
  }),

  /*
   * Hai handler dưới đây mount ở nhánh `/platform-admin`, không phải `/categories`: danh mục
   * là từ điển dùng chung toàn hệ thống (convention §1.3) nên quản trị một trường không được
   * sửa nó. Route nằm bên `platform-admin.routes.ts` cùng chỗ với organization — hai
   * thực thể trên-tenant còn lại — còn nghiệp vụ thì ở lại trong feature này.
   */

  // POST /platform-admin/categories
  create: catchAsync(async (req, res) => {
    const category = await categoryService.create(req.body, req.user!.id)
    created(res, { message: 'Category created', data: category })
  }),

  // PATCH /platform-admin/categories/:id
  update: catchAsync(async (req, res) => {
    const category = await categoryService.update(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Category updated', data: category })
  }),
}
