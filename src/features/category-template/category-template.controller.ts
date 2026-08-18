import { categoryTemplateService } from './category-template.service'
import { TemplateQuery } from './category-template.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const categoryTemplateController = {
  // GET /categories/:id/template
  getForCategory: catchAsync(async (req, res) => {
    const { version } = req.query as TemplateQuery
    const template = await categoryTemplateService.getForCategory(req.params.id, version)
    success(res, { message: 'Category template', data: template })
  }),
}
