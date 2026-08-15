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
import moderationRoutes from './moderation/moderation.routes'
import reportRoutes from './report/report.routes'
import locationRoutes from './location/location.routes'

const router = Router()

// --- Core modules ---
router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/listings', listingRoutes)
router.use('/categories', categoryRoutes)
router.use('/chats', chatRoutes)
router.use('/chains', chainRoutes)
router.use('/notifications', notificationRoutes)
router.use('/reports', reportRoutes)
// Từ điển hành chính, không thuộc tenant nào — cùng nhóm "dùng chung" với /categories.
router.use('/locations', locationRoutes)

// --- Bàn quản trị của một trường (owner | moderator) ---
router.use('/moderation', moderationRoutes)

// --- Skeleton modules (trả 501 cho tới khi triển khai) ---
router.use('/uploads', uploadRoutes)
router.use('/search', searchRoutes)
router.use('/reviews', reviewRoutes)

export default router
