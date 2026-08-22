import { Request } from 'express'
import { listingService, ListingAuthor } from './listing.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'
import { currentScope } from '../../common/tenant/tenantContext'
import { trustRepository } from '../trust/trust.repository'

/**
 * Bối cảnh người đăng, dựng một lần từ scope + membership.
 *
 * `trustLevel` là MỘT bậc dùng chung cho mọi luồng đăng — không còn tra theo trục như v2 gốc.
 * Xem `trust.model.ts` cho quyết định này và cái giá của nó.
 */
async function listingAuthor(req: Request): Promise<ListingAuthor> {
  const orgId = currentScope()?.ownOrgId?.toString() ?? null
  const trustLevel = await trustRepository.levelOf(req.user!.id)

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
    const listing = await listingService.create(req.body, await listingAuthor(req))
    created(res, { message: 'Listing created (pending review)', data: listing })
  }),

  // GET /listings/quota
  quota: catchAsync(async (req, res) => {
    const data = await listingService.quotaStatus(
      await listingAuthor(req),
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
