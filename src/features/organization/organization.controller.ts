import { organizationService } from './organization.service'
import { toOrganizationCardDto, toOrganizationDto } from './organization.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const organizationController = {
  // POST /organizations/:organizationId/admin
  grantAdmin: catchAsync(async (req, res) => {
    const org = await organizationService.grantAdmin(
      req.params.organizationId,
      req.body.email,
      req.user!.id,
    )
    success(res, { message: 'Organization admin granted', data: toOrganizationDto(org) })
  }),

  // PATCH /organizations/current
  update: catchAsync(async (req, res) => {
    const org = await organizationService.update(req.body)
    success(res, { message: 'Organization updated', data: toOrganizationDto(org) })
  }),

  // POST /organizations/current/join-code
  rotateJoinCode: catchAsync(async (req, res) => {
    const org = await organizationService.rotateJoinCode()
    success(res, { message: 'Join code rotated', data: toOrganizationDto(org) })
  }),

  // GET /organizations/by-code/:code
  byCode: catchAsync(async (req, res) => {
    const { org, memberCount } = await organizationService.getByJoinCode(req.params.code)
    success(res, { message: 'Organization', data: toOrganizationCardDto(org, memberCount) })
  }),

  // GET /organizations/mine
  mine: catchAsync(async (req, res) => {
    const data = await organizationService.listMine(req.user!.id)
    success(res, { message: 'Tổ chức của tôi', data })
  }),

  // GET /organizations/profile/:slug  (công khai)
  publicProfile: catchAsync(async (req, res) => {
    // `req.user` có thể vắng: route công khai, khách chưa đăng nhập vẫn xem được hồ sơ.
    const data = await organizationService.publicProfile(req.params.slug, req.user?.id ?? null)
    success(res, { message: 'Hồ sơ nhóm', data })
  }),

  // GET /organizations/lookup?q=
  lookup: catchAsync(async (req, res) => {
    const data = await organizationService.discover(String(req.query.q ?? ''))
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

  // GET /organizations  (master)
  listAll: catchAsync(async (req, res) => {
    const { items, meta } = await organizationService.listAll(req.query as never)
    success(res, { message: 'Tổ chức', data: items, meta })
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
