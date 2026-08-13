import { moderationService } from './moderation.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const moderationController = {
  // GET /moderation/overview
  overview: catchAsync(async (req, res) => {
    const data = await moderationService.overview(req.user!)
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
    const listing = await moderationService.setListingStatus(req.params.id, req.body, req.user!)
    success(res, { message: 'Listing status updated', data: listing })
  }),

  // DELETE /moderation/listings/:id
  removeListing: catchAsync(async (req, res) => {
    await moderationService.removeListing(req.params.id, req.user!)
    success(res, { message: 'Listing removed' })
  }),
}
