import { moderationService } from './moderation.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { orgActor } from '../../common/utils/actor'
import { success } from '../../common/utils/apiResponse'

export const moderationController = {
  // GET /moderation/public-queue
  publicQueue: catchAsync(async (req, res) => {
    const { items, meta } = await moderationService.publicQueue(req.query as never)
    success(res, { message: 'Hàng đợi trục danh mục', data: items, meta })
  }),

  // GET /moderation/coverage
  coverage: catchAsync(async (_req, res) => {
    const data = await moderationService.coverage()
    success(res, { message: 'Ma trận phủ sóng', data })
  }),

  // PATCH /moderation/listings/:id/route
  reroute: catchAsync(async (req, res) => {
    const listing = await moderationService.reroute(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Đã chuyển ô phụ trách', data: listing })
  }),

  // GET /moderation/overview
  overview: catchAsync(async (req, res) => {
    const data = await moderationService.overview(orgActor(req, 'moderation.overview'))
    success(res, { message: 'Moderation overview', data })
  }),

  // GET /moderation/listings
  listings: catchAsync(async (req, res) => {
    const { items, meta } = await moderationService.listings(req.query as never)
    success(res, { message: 'Listings for moderation', data: items, meta })
  }),

  // GET /moderation/activity
  activity: catchAsync(async (req, res) => {
    const { items, meta } = await moderationService.activity(req.query as never)
    success(res, { message: 'Activity', data: items, meta })
  }),

  // PATCH /moderation/listings/:id
  setListingStatus: catchAsync(async (req, res) => {
    const listing = await moderationService.setListingStatus(req.params.id, req.body, {
      ...orgActor(req, 'moderation.setStatus'),
      grants: req.grants!,
    })
    success(res, { message: 'Listing status updated', data: listing })
  }),

  // DELETE /moderation/listings/:id
  removeListing: catchAsync(async (req, res) => {
    await moderationService.removeListing(req.params.id, {
      ...orgActor(req, 'moderation.remove'),
      grants: req.grants!,
    })
    success(res, { message: 'Listing removed' })
  }),
}
