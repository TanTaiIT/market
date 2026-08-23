import { listingProductService } from './listing-product.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const listingProductController = {
  // GET /listing-products
  list: catchAsync(async (_req, res) => {
    const products = await listingProductService.listForAdmin()
    success(res, { message: 'Listing products (admin)', data: products })
  }),

  // POST /listing-products
  create: catchAsync(async (req, res) => {
    const product = await listingProductService.create(req.body, req.user!.id)
    created(res, { message: 'Listing product created', data: product })
  }),

  // PATCH /listing-products/:id
  update: catchAsync(async (req, res) => {
    const product = await listingProductService.update(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Listing product updated', data: product })
  }),

  // DELETE /listing-products/:id
  remove: catchAsync(async (req, res) => {
    const product = await listingProductService.remove(req.params.id, req.user!.id)
    success(res, { message: 'Listing product removed', data: product })
  }),
}
