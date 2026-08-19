import { favoriteService } from './favorite.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const favoriteController = {
  // GET /favorites
  list: catchAsync(async (req, res) => {
    const { items, meta } = await favoriteService.list(req.user!.id, req.query as never)
    success(res, { message: 'Saved listings', data: items, meta })
  }),

  // GET /favorites/ids
  ids: catchAsync(async (req, res) => {
    const data = await favoriteService.listIds(req.user!.id)
    success(res, { message: 'Saved listing ids', data })
  }),

  // POST /favorites/:listingId
  add: catchAsync(async (req, res) => {
    const data = await favoriteService.add(req.user!.id, req.params.listingId)
    created(res, { message: 'Saved', data })
  }),

  // DELETE /favorites/:listingId
  remove: catchAsync(async (req, res) => {
    const data = await favoriteService.remove(req.user!.id, req.params.listingId)
    success(res, { message: 'Unsaved', data })
  }),
}
