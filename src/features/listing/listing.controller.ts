import { Request } from 'express'
import { listingService, ListingAuthor } from './listing.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'
import { currentScope } from '../../common/tenant/tenantContext'
import { trustRepository } from '../trust/trust.repository'
import { POST_VISIBILITY } from '../../common/constants'

/**
 * Bối cảnh người đăng, dựng một lần từ scope + membership.
 *
 * `trustLevel` lấy theo ĐÚNG TRỤC đang đăng: uy tín trong một org không chuyển thành quyền tự
 * đăng ở danh mục công khai toàn tỉnh, và ngược lại (§8.3).
 */
async function listingAuthor(req: Request, body: Record<string, unknown>): Promise<ListingAuthor> {
  const orgId = currentScope()?.ownOrgId?.toString() ?? null
  const categoryId = typeof body.categoryId === 'string' ? body.categoryId : null
  const isPublic = body.visibility === POST_VISIBILITY.PUBLIC

  // Thiếu `categoryId` thì không tra được uy tín trục công khai — trả bậc 0 thay vì ném
  // `categoryId: 'undefined'` xuống Mongo và nhận CastError 500 cho một query chỉ để đọc.
  const trustLevel =
    isPublic && categoryId
      ? await trustRepository.levelOf(req.user!.id, categoryId)
      : (req.membership?.trustLevel ?? 0)

  return {
    id: req.user!.id,
    organizationId: orgId,
    isMember: Boolean(req.membership),
    unitId: req.membership?.unitId ?? null,
    trustLevel,
  }
}

export const listingController = {
  // POST /listings
  create: catchAsync(async (req, res) => {
    const listing = await listingService.create(req.body, await listingAuthor(req, req.body))
    created(res, { message: 'Listing created (pending review)', data: listing })
  }),

  // GET /listings/quota
  quota: catchAsync(async (req, res) => {
    const data = await listingService.quotaStatus(
      await listingAuthor(req, req.query as Record<string, unknown>),
      req.query.categoryId as string | undefined,
    )
    success(res, { message: 'Quota', data })
  }),

  // GET /listings
  list: catchAsync(async (req, res) => {
    const { items, meta } = await listingService.list(req.query as never)
    success(res, { message: 'Listings', data: items, meta })
  }),

  // GET /listings/mine
  mine: catchAsync(async (req, res) => {
    const { items, meta } = await listingService.listMine(req.user!.id, req.query as never)
    success(res, { message: 'My listings', data: items, meta })
  }),

  // GET /listings/nearby
  nearby: catchAsync(async (req, res) => {
    const { items, meta } = await listingService.nearby(req.query as never)
    success(res, { message: 'Nearby listings', data: items, meta })
  }),

  // GET /listings/:id
  getById: catchAsync(async (req, res) => {
    const listing = await listingService.getByIdAndTrackView(req.params.id)
    success(res, { message: 'Listing detail', data: listing })
  }),

  // PATCH /listings/:id
  update: catchAsync(async (req, res) => {
    const listing = await listingService.update(req.params.id, req.user!.id, req.body)
    success(res, { message: 'Listing updated', data: listing })
  }),

  // DELETE /listings/:id
  remove: catchAsync(async (req, res) => {
    await listingService.remove(req.params.id, req.user!.id)
    success(res, { message: 'Listing deleted' })
  }),
}
