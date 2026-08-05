import { Router } from 'express'
import { listingController } from './listing.controller'
import {
  createListingSchema,
  updateListingSchema,
  listingQuerySchema,
  nearbyQuerySchema,
  listingParamsSchema,
} from './listing.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'

const router = Router()

// Public
router.get('/', validate({ query: listingQuerySchema }), listingController.list)
router.get('/nearby', validate({ query: nearbyQuerySchema }), listingController.nearby)
router.get('/:id', validate({ params: listingParamsSchema }), listingController.getById)

// Protected (chủ tin)
router.post(
  '/',
  authenticate,
  apiLimiter,
  validate({ body: createListingSchema }),
  listingController.create,
)
router.patch(
  '/:id',
  authenticate,
  validate({ params: listingParamsSchema, body: updateListingSchema }),
  listingController.update,
)
router.delete(
  '/:id',
  authenticate,
  validate({ params: listingParamsSchema }),
  listingController.remove,
)

export default router
