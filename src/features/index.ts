import { Router } from 'express'
import authRoutes from './auth/auth.routes'
import userRoutes from './user/user.routes'
import listingRoutes from './listing/listing.routes'
import favoriteRoutes from './favorite/favorite.routes'
import organizationRoutes from './organization/organization.routes'
import orgUnitRoutes from './org-unit/org-unit.routes'
import joinRequestRoutes from './join-request/join-request.routes'
import membershipRoutes from './membership/membership.routes'
import inviteRoutes from './invite/invite.routes'
import roleGrantRoutes from './role-grant/role-grant.routes'
import categoryRoutes from './category/category.routes'
import fieldDefinitionRoutes from './category-template/field-definition.routes'
import defaultTemplateRoutes from './category-template/default-template.routes'
import chatRoutes from './chat/chat.routes'
import uploadRoutes from './upload/upload.routes'
import searchRoutes from './search/search.routes'
import reviewRoutes from './review/review.routes'
import notificationRoutes from './notification/notification.routes'
import moderationRoutes from './moderation/moderation.routes'
import moderationWebhookRoutes from './moderation/moderation.webhook.routes'
import reportRoutes from './report/report.routes'
import locationRoutes from './location/location.routes'
import bannedPhraseRoutes from './banned-phrase/banned-phrase.routes'
import listingProductRoutes from './listing-product/listing-product.routes'
import walletRoutes from './wallet/wallet.routes'

const router = Router()

// --- Core modules ---
router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/listings', listingRoutes)
router.use('/favorites', favoriteRoutes)
router.use('/organizations', organizationRoutes)
router.use('/org-units', orgUnitRoutes)
router.use('/join-requests', joinRequestRoutes)
router.use('/memberships', membershipRoutes)
router.use('/invites', inviteRoutes)
router.use('/role-grants', roleGrantRoutes)
router.use('/categories', categoryRoutes)
router.use('/field-definitions', fieldDefinitionRoutes)
// Mẫu template mặc định — không thuộc danh mục nào, nên không nằm dưới /categories.
router.use('/default-template', defaultTemplateRoutes)
router.use('/chats', chatRoutes)
router.use('/notifications', notificationRoutes)
router.use('/reports', reportRoutes)
// Từ điển hành chính, không thuộc tenant nào — cùng nhóm "dùng chung" với /categories.
router.use('/locations', locationRoutes)
// Từ điển cụm cấm của cổng nội dung — master-only kể cả đọc (xem banned-phrase.routes.ts).
router.use('/banned-phrases', bannedPhraseRoutes)
// Bàn quản trị catalog gói tin — master-only; đường xem công khai nằm ở /listings/products.
router.use('/listing-products', listingProductRoutes)
// Ví Xu — của chính chủ; master chỉ có đường cộng/trừ, không có đường đọc ví người khác.
router.use('/wallet', walletRoutes)

// --- Bàn quản trị của một org (manager | staff, xét bằng role_grants) ---
router.use('/moderation', moderationRoutes)

// --- Webhook máy-gọi-máy (Cloudinary báo kết quả kiểm duyệt ảnh) — xác thực bằng chữ ký ---
router.use('/webhooks', moderationWebhookRoutes)

// --- Skeleton modules (trả 501 cho tới khi triển khai) ---
router.use('/uploads', uploadRoutes)
router.use('/search', searchRoutes)
router.use('/reviews', reviewRoutes)

export default router
