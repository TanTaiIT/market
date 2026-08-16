import { organizationService } from './organization.service'
import { toOrganizationDto } from './organization.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const organizationController = {
  // GET /organizations/mine
  mine: catchAsync(async (req, res) => {
    const data = await organizationService.listMine(req.user!.id)
    success(res, { message: 'Tổ chức của tôi', data })
  }),

  // GET /organizations/lookup?q=
  lookup: catchAsync(async (req, res) => {
    const data = await organizationService.lookup(String(req.query.q))
    success(res, { message: 'Organization lookup', data })
  }),

  // GET /organizations/slug-availability?slug=
  slugAvailability: catchAsync(async (req, res) => {
    const data = await organizationService.checkSlugAvailability(String(req.query.slug), {
      district: req.query.district ? String(req.query.district) : null,
      provinceCode: req.query.provinceCode ? String(req.query.provinceCode) : null,
    })
    success(res, { message: 'Slug availability', data })
  }),

  // POST /organizations  (master)
  create: catchAsync(async (req, res) => {
    const org = await organizationService.createByMaster(req.user!.id, req.body)
    created(res, { message: 'Đã tạo tổ chức', data: toOrganizationDto(org) })
  }),

  // PATCH /organizations/:organizationId/status  (master)
  setStatus: catchAsync(async (req, res) => {
    const org = await organizationService.setStatus(req.params.organizationId, req.body.status)
    success(res, { message: 'Đã cập nhật trạng thái', data: toOrganizationDto(org) })
  }),

  // PATCH /organizations/:organizationId/slug  (master)
  changeSlug: catchAsync(async (req, res) => {
    const org = await organizationService.changeSlug(req.params.organizationId, req.body.slug)
    success(res, { message: 'Đã đổi slug', data: toOrganizationDto(org) })
  }),
}
