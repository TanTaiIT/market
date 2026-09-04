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
  const trust = await trustRepository.stateOf(req.user!.id)

  return {
    id: req.user!.id,
    organizationId: orgId,
    isMember: Boolean(req.membership),
    unitId: req.membership?.unitId ?? null,
    trustLevel: trust.level,
    cleanApprovals: trust.cleanApprovals,
  }
}

export const listingController = {
  // POST /listings
  create: catchAsync(async (req, res) => {
    const author = await listingAuthor(req)
    const listing = await listingService.create(req.body, author)
    created(res, {
      message: 'Listing created (pending review)',
      data: listing,
      // Biên lai của HÀNH ĐỘNG chứ không phải thuộc tính của tin — nên nằm ở meta.
      meta: { fee: listingService.feeQuote(author, req.body.categoryId) },
    })
  }),

  // GET /listings/quota
  quota: catchAsync(async (req, res) => {
    const data = await listingService.quotaStatus(
      await listingAuthor(req),
      req.query.categoryId as string | undefined,
    )
    success(res, { message: 'Quota', data })
  }),

  // GET /listings/products
  products: catchAsync(async (_req, res) => {
    const products = await listingService.productCatalog()
    success(res, { message: 'Listing products', data: products })
  }),

  // GET /listings/posting-stats
  postingStats: catchAsync(async (req, res) => {
    // validate() đã ghi query parse xong (kèm default) ngược vào req.query — chỉ việc đọc.
    const days = Number(req.query.days)
    const data = await listingService.postingStats(days)
    success(res, { message: 'Posting stats', data, meta: { days } })
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

  // POST /listings/:id/bump
  bump: catchAsync(async (req, res) => {
    // `req.grants` do `requireAnyModerator` nạp sẵn — cổng route đã chạy trước handler này.
    const listing = await listingService.bump(req.params.id, req.grants!)
    success(res, { message: 'Đã đẩy tin lên đầu bảng', data: listing })
  }),

  // POST /listings/:id/renew
  renew: catchAsync(async (req, res) => {
    const listing = await listingService.renew(req.params.id, req.user!.id)
    success(res, { message: 'Đã gia hạn tin', data: listing })
  }),

  // POST /listings/:id/sold
  markSold: catchAsync(async (req, res) => {
    const listing = await listingService.markSold(req.params.id, req.user!.id)
    success(res, { message: 'Đã đánh dấu tin là đã bán', data: listing })
  }),

  // DELETE /listings/:id
  remove: catchAsync(async (req, res) => {
    await listingService.remove(req.params.id, req.user!.id)
    success(res, { message: 'Listing deleted' })
  }),
}
