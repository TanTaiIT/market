import { listingService } from './listing.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const listingController = {
  // POST /listings
  create: catchAsync(async (req, res) => {
    const listing = await listingService.create(req.body, req.user!)
    created(res, { message: 'Listing created (pending review)', data: listing })
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
