import { Router } from 'express'
import authRoutes from './auth/auth.routes'
import userRoutes from './user/user.routes'
import listingRoutes from './listing/listing.routes'
import favoriteRoutes from './favorite/favorite.routes'
import organizationRoutes from './organization/organization.routes'
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
import reportRoutes from './report/report.routes'
import locationRoutes from './location/location.routes'
import bannedPhraseRoutes from './banned-phrase/banned-phrase.routes'
import listingProductRoutes from './listing-product/listing-product.routes'
import walletRoutes from './wallet/wallet.routes'
import metricsRoutes from './metrics/metrics.routes'
// Lớp phủ tuân thủ — xem khối `kycGate` bên dưới. Hai import này đi cùng nhau và cùng bị gỡ.
import kycRoutes from './kyc/kyc.routes'
import { kycGate } from './kyc/kyc.middleware'
import { optionalAuth } from '../middlewares/auth.middleware'
import { env } from '../config/env'
import supportRoutes from './support/support.routes'
import socialFeedbackRoutes from './social-feedback/social-feedback.routes'

const router = Router()

/*
 * LỚP PHỦ TUÂN THỦ — Bộ Công Thương đòi tài khoản phải qua duyệt mới dùng được.
 *
 * Cả khối này là TOÀN BỘ chỗ nó chạm vào hệ thống. Ba điều phải đúng cùng lúc:
 *
 * 1. ĐỨNG TRƯỚC mọi route nghiệp vụ — Express khớp theo thứ tự; đặt ở cuối file thì cổng không
 *    bao giờ chạy cho `/listings`. (`/auth` và `/kyc` nằm trong allowlist của chính nó.)
 * 2. KÈM `optionalAuth` — `authenticate` chạy BÊN TRONG từng feature router, nên ở tầng này
 *    `req.user` chưa tồn tại và cổng sẽ cho qua tất. Đây là bản `optionalAuth`: token hỏng thì
 *    coi như khách, không ném.
 * 3. CHỈ MOUNT KHI CỜ BẬT. Tắt cờ thì không một middleware nào được cắm vào — không phải "cắm
 *    rồi trả về sớm". Đó là khác biệt giữa "không ảnh hưởng" và "gần như không ảnh hưởng".
 *
 * Gỡ về sau = xoá khối này, hai `import` ở trên, và thư mục `features/kyc`.
 */
if (env.KYC_REQUIRED) router.use(optionalAuth, kycGate)
router.use('/kyc', kycRoutes)

// --- Core modules ---
router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/listings', listingRoutes)
router.use('/favorites', favoriteRoutes)
router.use('/organizations', organizationRoutes)
router.use('/join-requests', joinRequestRoutes)
router.use('/memberships', membershipRoutes)
router.use('/invites', inviteRoutes)
router.use('/role-grants', roleGrantRoutes)
// Kênh người dùng <-> đội ngũ nền tảng. KHÔNG đọc `X-Org-Id` — xem docblock của routes.
router.use('/support', supportRoutes)
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

// --- Nghĩa vụ công bố pháp lý (cụm TẠM THỜI — công thức gỡ ở social-feedback.model.ts) ---
// Ghi lẫn đọc đều KHÔNG đăng nhập; bàn duyệt nằm bên trong router và là master-only.
router.use('/social-feedback', socialFeedbackRoutes)

// --- Bàn của master: số liệu gộp MỌI tổ chức, nên master-only tuyệt đối ---
router.use('/metrics', metricsRoutes)

// --- Bàn quản trị của một org (manager | staff, xét bằng role_grants) ---
router.use('/moderation', moderationRoutes)

// --- Ký cho app upload ảnh thẳng lên Cloudinary (server không nhận file) ---
router.use('/uploads', uploadRoutes)

// --- Skeleton modules (trả 501 cho tới khi triển khai) ---
router.use('/search', searchRoutes)
router.use('/reviews', reviewRoutes)

export default router
