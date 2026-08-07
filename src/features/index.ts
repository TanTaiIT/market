import { Router } from 'express'
import authRoutes from './auth/auth.routes'
import userRoutes from './user/user.routes'
import listingRoutes from './listing/listing.routes'
import chainRoutes from './chain/chain.routes'
import categoryRoutes from './category/category.routes'
import chatRoutes from './chat/chat.routes'
import uploadRoutes from './upload/upload.routes'
import searchRoutes from './search/search.routes'
import reviewRoutes from './review/review.routes'
import notificationRoutes from './notification/notification.routes'

const router = Router()

// --- Core modules ---
router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/listings', listingRoutes)
router.use('/chains', chainRoutes)
router.use('/notifications', notificationRoutes)

// --- Skeleton modules (trả 501 cho tới khi triển khai) ---
router.use('/categories', categoryRoutes)
router.use('/chats', chatRoutes)
router.use('/uploads', uploadRoutes)
router.use('/search', searchRoutes)
router.use('/reviews', reviewRoutes)

export default router
