import { categoryTemplateService } from './category-template.service'
import { TemplateQuery } from './category-template.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { created, success } from '../../common/utils/apiResponse'

export const categoryTemplateController = {
  // GET /field-definitions
  listDefinitions: catchAsync(async (_req, res) => {
    const data = await categoryTemplateService.listFieldDefinitions()
    success(res, { message: 'Field definitions', data })
  }),

  // POST /field-definitions
  createDefinition: catchAsync(async (req, res) => {
    const data = await categoryTemplateService.createFieldDefinition(req.body)
    created(res, { message: 'Field definition created', data })
  }),

  // POST /categories/:id/template
  createDraft: catchAsync(async (req, res) => {
    const data = await categoryTemplateService.createDraft(req.params.id, req.body)
    created(res, { message: 'Template draft created', data })
  }),

  // PATCH /categories/:id/template/:version
  updateDraft: catchAsync(async (req, res) => {
    const { version } = req.params as unknown as { version: number }
    const data = await categoryTemplateService.updateDraft(req.params.id, Number(version), req.body)
    success(res, { message: 'Template draft updated', data })
  }),

  // POST /categories/:id/template/:version/publish
  publish: catchAsync(async (req, res) => {
    const data = await categoryTemplateService.publish(req.params.id, Number(req.params.version))
    success(res, { message: 'Template published', data })
  }),

  // GET /categories/:id/template
  getForCategory: catchAsync(async (req, res) => {
    const { version } = req.query as TemplateQuery
    const template = await categoryTemplateService.getForCategory(req.params.id, version)
    success(res, { message: 'Category template', data: template })
  }),
}
