import { z } from 'zod'
import { registry } from '../../config/openapi'
import { ORG_TYPES, TENANT_STATUS, VERIFICATION_TIERS } from '../../common/constants'
import { cloudinaryImageUrl } from '../../common/utils/imageUrl'

export const organizationSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug chỉ gồm a-z, 0-9 và dấu gạch ngang')

export const organizationSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** Mã để mời người vào nhóm. Chỉ trả cho người có quyền đọc org này, không nằm ở thẻ công khai. */
    joinCode: z.string(),
    avatarUrl: z.string().nullable(),
    description: z.string(),
    orgType: z.nativeEnum(ORG_TYPES),
    verificationTier: z.nativeEnum(VERIFICATION_TIERS),
    provinceCode: z.string().nullable(),
    /** Union thật, không phải `string`: client dựng bộ lọc + nhãn từ đúng tập này. */
    status: z.nativeEnum(TENANT_STATUS),
  })
  .openapi('Organization')

/**
 * Một dòng trong danh sách nhóm — kết quả tìm và khối "Gợi ý cho bạn".
 *
 * CHỈ nhóm `isPublic` mới lọt vào đây, nên trả `joinCode` là hợp lệ: nhóm công khai vốn xin vào
 * được bằng slug, cái mã lúc đó chỉ còn là lối tắt gõ nhanh chứ không còn là cổng chặn. Nhóm
 * riêng tư không bao giờ xuất hiện ở route này, mã của họ vẫn kín.
 *
 * Vẫn KHÔNG có `id` — xem `toOrganizationLookupDto`. Slug đủ để mở hồ sơ nhóm.
 */
export const organizationLookupSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    joinCode: z.string(),
    avatarUrl: z.string().nullable(),
    memberCount: z.number(),
    district: z.string().nullable(),
    provinceCode: z.string().nullable(),
    allowJoinRequests: z.boolean(),
    allowOutsiderPosts: z.boolean(),
  })
  .openapi('OrganizationLookup')

/**
 * Hồ sơ nhóm công khai, mở theo slug — màn người dùng đọc TRƯỚC khi bấm xin vào.
 *
 * Khác `OrganizationCard` (tra bằng mã) ở chỗ có `slug`: card sinh ra cho người đã cầm mã và cố
 * tình không cho lần ngược ra định danh, còn ở đây nhóm vốn đã công khai nên giấu slug là giấu
 * chính cái địa chỉ vừa dùng để tới.
 */
export const organizationProfileSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    joinCode: z.string(),
    avatarUrl: z.string().nullable(),
    coverUrl: z.string().nullable(),
    description: z.string(),
    provinceCode: z.string().nullable(),
    district: z.string().nullable(),
    memberCount: z.number(),
    /** Số tin đăng trong 7 ngày qua — nhịp sống của nhóm, thứ quyết định có đáng vào hay không. */
    postsThisWeek: z.number(),
    rules: z.array(z.string()),
    allowJoinRequests: z.boolean(),
    /** Người đang xem đã là thành viên chưa — quyết định nút hiện "Tham gia" hay "Đã tham gia". */
    joined: z.boolean(),
  })
  .openapi('OrganizationProfile')

/**
 * `q` TUỲ CHỌN: bỏ trống nghĩa là "gợi ý cho tôi", đúng trạng thái đầu của màn khám phá nhóm.
 * Bỏ mức tối thiểu 2 ký tự cùng lý do — không còn là dropdown tra cứu mà là một danh sách.
 */
export const organizationLookupQuerySchema = z.object({
  q: z.string().max(80).optional(),
})

/**
 * Bảng tổ chức của master. Khác `lookup` ở hai điểm quyết định:
 *
 * `lookup` là route CÔNG KHAI nên cố tình không trả `id` — có `id` thì nó thành công cụ liệt kê
 * khách hàng. Bảng này chỉ master gọi được, và `id` chính là thứ nó tồn tại để trả: master
 * không thuộc org nào cả, nên đây là nguồn DUY NHẤT để họ chọn org đang thao tác (`X-Org-Slug`).
 *
 * `q` không có min 2 ký tự: bỏ trống nghĩa là "liệt kê tất cả", đúng nhu cầu của một bảng quản trị.
 */
export const organizationAdminQuerySchema = z.object({
  q: z.string().max(80).optional(),
  status: z.nativeEnum(TENANT_STATUS).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * Nhánh kiểm tra khả dụng lúc TẠO org: nhận slug thô (chưa chuẩn hoá) vì người dùng đang gõ,
 * service sẽ tự fold. Response chỉ có available + gợi ý, không có tên org nào.
 */
export const slugAvailabilityQuerySchema = z.object({
  slug: z.string().min(1).max(80),
  district: z.string().max(100).optional(),
  provinceCode: z.string().max(60).optional(),
})

export const slugAvailabilitySchema = z
  .object({
    slug: z.string(),
    available: z.boolean(),
    reason: z.enum(['invalid', 'reserved', 'taken']).optional(),
    suggestions: z.array(z.string()).optional(),
  })
  .openapi('SlugAvailability')

export const myOrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    avatarUrl: z.string().nullable(),
    provinceCode: z.string().nullable(),
    role: z.string(),
    unitId: z.string().nullable(),
  })
  .openapi('MyOrganization')

/** Thẻ nhóm cho người cầm mã — cố tình KHÔNG có `id`, `slug` hay chính cái mã. */
export const organizationCardSchema = z
  .object({
    name: z.string(),
    avatarUrl: z.string().nullable(),
    description: z.string(),
    provinceCode: z.string().nullable(),
    district: z.string().nullable(),
    memberCount: z.number(),
    allowJoinRequests: z.boolean(),
  })
  .openapi('OrganizationCard')

export const orgSlugParamsSchema = z.object({ slug: organizationSlugSchema })

export const joinCodeParamsSchema = z.object({
  code: z.string().min(4).max(16),
})

export const organizationParamsSchema = z.object({
  organizationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
})

/**
 * Tạo org — chỉ master. `ownerEmail` chứ không phải `ownerId`: master thao tác theo email của
 * người chủ, và tài khoản đó phải tồn tại trước (đăng ký là việc của chính họ).
 */
export const createOrganizationSchema = z
  .object({
    name: z.string().min(1).max(150).openapi({ example: 'THPT Lý Thường Kiệt' }),
    slug: organizationSlugSchema.optional().openapi({ example: 'thpt-ly-thuong-kiet' }),
    orgType: z.nativeEnum(ORG_TYPES).optional(),
    provinceCode: z.string().max(60).optional(),
    district: z.string().max(100).optional(),
  })
  .strict()
  .openapi('CreateOrganization')

/**
 * Trao quyền phụ trách. Nhận EMAIL chứ không phải id: master thao tác theo danh sách người
 * thật, và bắt họ đi tra id trước là thêm một bước không giúp gì cho độ chính xác.
 */
export const grantOrgAdminSchema = z
  .object({ email: z.string().email() })
  .strict()
  .openapi('GrantOrganizationAdmin')

/**
 * `pending_admin` KHÔNG nằm trong tập này: nó là trạng thái do hệ thống đặt lúc tạo org và tự
 * gỡ khi có người phụ trách. Cho master set tay thì org đang chạy bị đẩy ngược về vô chủ, mà
 * không có đường nào đưa nó trở lại ngoài việc trao quyền lần nữa.
 */
/**
 * Hồ sơ nhóm, do ADMIN của chính org sửa — khác mọi endpoint org khác vốn chỉ master gọi được.
 *
 * `null` cho ảnh nghĩa là GỠ, khác hẳn bỏ trống (không đổi). Không có `null` thì không có cách
 * nào xoá một cái avatar đã đặt.
 *
 * `slug` KHÔNG nằm ở đây: đổi slug là đổi mọi link chia sẻ đã phát ra ngoài, nên nó ở lại chỗ
 * cũ của master.
 */
export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(150).optional(),
    description: z.string().max(500).optional(),
    avatarUrl: cloudinaryImageUrl.nullable().optional(),
    coverUrl: cloudinaryImageUrl.nullable().optional(),
    allowJoinRequests: z.boolean().optional(),
    /**
     * Nhóm có nhận tin từ người KHÔNG phải thành viên không. Bật (mặc định) = ai cũng gửi
     * tin vào được, tin nằm ở hàng đợi `pending_unverified` chờ quản trị nhóm duyệt.
     * Tắt = nhóm kín, chỉ thành viên đăng được.
     */
    allowOutsiderPosts: z.boolean().optional(),
    /**
     * Nội quy nhóm. GỬI CẢ MẢNG, không phải thêm/xoá từng dòng: nội quy là một văn bản ngắn
     * mà quản trị sửa cả cụm, và API từng-dòng sẽ cần thêm id cho mỗi dòng chỉ để phục vụ một
     * thao tác mà giao diện không có.
     *
     * Mảng rỗng = xoá hết nội quy, hợp lệ. `max(10)` để nó vẫn là nội quy chứ không thành
     * điều khoản sử dụng; mỗi dòng `max(200)` vì nó hiển thị nguyên văn trên thẻ hồ sơ nhóm.
     */
    rules: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  })
  .strict()
  .openapi('UpdateOrganization')

export const setOrgStatusSchema = z
  .object({ status: z.enum([TENANT_STATUS.ACTIVE, TENANT_STATUS.SUSPENDED]) })
  .strict()
  .openapi('SetOrganizationStatus')

export const changeOrgSlugSchema = z
  .object({ slug: organizationSlugSchema })
  .strict()
  .openapi('ChangeOrganizationSlug')

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type GrantOrgAdminInput = z.infer<typeof grantOrgAdminSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
export type OrganizationSummaryDto = z.infer<typeof organizationSummarySchema>
export type OrganizationLookupDto = z.infer<typeof organizationLookupSchema>
export type OrganizationProfileDto = z.infer<typeof organizationProfileSchema>
export type OrganizationAdminQuery = z.infer<typeof organizationAdminQuerySchema>

registry.register('Organization', organizationSummarySchema)
registry.register('OrganizationLookup', organizationLookupSchema)
registry.register('OrganizationProfile', organizationProfileSchema)
registry.register('MyOrganization', myOrganizationSchema)
registry.register('UpdateOrganization', updateOrganizationSchema)
registry.register('OrganizationCard', organizationCardSchema)
registry.register('SlugAvailability', slugAvailabilitySchema)
registry.register('CreateOrganization', createOrganizationSchema)
registry.register('SetOrganizationStatus', setOrgStatusSchema)
registry.register('ChangeOrganizationSlug', changeOrgSlugSchema)
