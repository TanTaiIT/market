import { z } from 'zod'
import { cloudinaryImageUrl } from '../../common/utils/imageUrl'
import { registry } from '../../config/openapi'
import { organizationSlugSchema } from '../organization/organization.schema'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  POST_VISIBILITY,
  VN_PROVINCE_NAMES,
  isWardOfProvince,
} from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Địa chỉ hành chính, KHÔNG có toạ độ. App không xin quyền định vị nên toạ độ chỉ có hai
 * đường: bỏ trống (tin rơi khỏi mọi tìm kiếm theo vị trí) hoặc bịa ra điểm tham chiếu tỉnh
 * (làm bẩn 2dsphere). Bỏ hẳn geo và tìm "tin gần đây" theo xã/tỉnh là đường thứ ba, đúng với
 * cách người mua thật sự nghĩ: "có ai bán cái này gần chỗ mình không".
 */
const locationSchema = z
  .object({
    address: z.string().max(255).optional(),
    province: z.enum(VN_PROVINCE_NAMES).optional().openapi({ example: 'Hồ Chí Minh' }),
    // Không enum như `province`: 3.321 phường/xã nhồi vào OpenAPI sẽ phình spec và SDK sinh ra
    // một union khổng lồ. Ràng buộc "xã thuộc đúng tỉnh" nằm ở FE, nơi đã có sẵn bảng tra.
    ward: z.string().max(100).optional().openapi({ example: 'Phường Bến Thành' }),
  })
  // `.strict()` chứ không để zod lặng lẽ cắt bỏ: client bản cũ vẫn gửi `coordinates` phải nhận
  // 400 để biết mà sửa, chứ không phải tưởng đã gửi vị trí thành công rồi đi tìm mãi không thấy.
  .strict()

/**
 * Chốt cặp tỉnh/xã khớp nhau. Thiếu bước này thì `{ province: 'Hà Nội', ward: 'Phường Vũng Tàu' }`
 * lưu được, và `/listings/nearby` xếp hạng theo một cái xã không tồn tại trong tỉnh đó.
 * Chỉ dùng cho ĐẦU VÀO — schema response giữ nguyên object thuần để zod-to-openapi sinh ra
 * `Listing` không kèm ràng buộc chỉ có ý nghĩa lúc ghi.
 */
const locationInputSchema = locationSchema.superRefine((loc, ctx) => {
  if (loc.province && loc.ward && !isWardOfProvince(loc.province, loc.ward)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ward'],
      message: `"${loc.ward}" không thuộc ${loc.province}`,
    })
  }
})

export const createListingSchema = z
  .object({
    title: z.string().min(5).max(150).openapi({ example: 'Xe máy Honda Wave 2020' }),
    description: z.string().min(10).max(5000),
    price: z.number().nonnegative(),
    isNegotiable: z.boolean().optional(),
    condition: z.nativeEnum(LISTING_CONDITION).optional(),
    categoryId: objectId,
    // Cùng một luật với ảnh nhóm — trước đây đường này lỏng hơn, và đó là lỗ hổng thật: ảnh
    // host ở nơi khác đổi được ruột SAU KHI tin đã qua đủ bốn lớp duyệt.
    images: z.array(cloudinaryImageUrl).min(1).max(12),
    // Tuỳ chọn: tin không có khu vực vẫn hợp lệ, chỉ là nó không lên được bộ lọc theo tỉnh
    // và không xuất hiện ở `/listings/nearby` của ai cả.
    location: locationInputSchema.optional(),
    /**
     * Thuộc tính động theo template của danh mục. Zod chỉ chặn được HÌNH DẠNG (một tầng, giá
     * trị nguyên thuỷ hoặc mảng chuỗi) — "field nào bắt buộc, option nào hợp lệ" nằm trong DB
     * nên `validate()` (middleware tĩnh) không với tới. Chốt thật ở
     * `categoryTemplateService.validateForCategory`, gọi từ service.
     *
     * `unknown` chứ không `string`: form trả chuỗi nhưng client khác gửi số/boolean thật, và
     * ép hết về chuỗi ở đây là mất đúng thứ vừa sửa ở model.
     */
    attributes: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .optional(),

    /**
     * Đăng vào đâu. Mặc định `org_internal` — mặc định an toàn: tin ở lại trong tổ chức cho
     * tới khi người đăng chủ động chọn ra trang công khai, và lúc đó nó đi qua manager danh mục.
     */
    visibility: z.nativeEnum(POST_VISIBILITY).optional(),
    /**
     * Tỉnh quyết định AI DUYỆT ở trục công khai, nên nó tách khỏi `location` (vốn tuỳ chọn và
     * chỉ để hiển thị/lọc). Bỏ trống thì lấy `location.province`, rồi tới tỉnh của tổ chức.
     */
    provinceCode: z.enum(VN_PROVINCE_NAMES).optional(),
    /**
     * Chỉ dùng khi người đăng KHÔNG thuộc tổ chức đích (đường lùi "người ngoài đề xuất").
     * Thành viên không cần gửi: org của họ đến từ scope, và scope thì đã đối chiếu membership.
     */
    orgSlug: organizationSlugSchema.optional(),
  })
  .strict()
  .openapi('CreateListing')

/** Phí của một lượt đăng — sống trong hợp đồng API từ giai đoạn miễn phí (listing.pricing.ts). */
export const postingFeeSchema = z
  .object({
    amount: z.number().openapi({ example: 0 }),
    currency: z.literal('xu'),
  })
  .openapi('PostingFee')

/**
 * Vị thế đăng tin của CHÍNH CHỦ — thứ người bán được phép biết về mình.
 *
 * Cố tình KHÔNG trả con số bậc uy tín. Bậc chặn trần ở 2 (`MAX_TRUST_LEVEL`) nên trên giao
 * diện chỉ có hai trạng thái đáng nói: tin phải chờ duyệt, hay tin lên bảng ngay. Hiện số
 * bậc chỉ làm người dùng tưởng còn thang để leo, trong khi hệ thống không có gì ở trên đó.
 *
 * Trước đây khối này không tồn tại: người bán bị hạ bậc, mất quyền tự đăng, bị bóp hạn mức
 * — mà không có chỗ nào nhìn thấy vì sao hay còn bao lâu. Một hệ uy tín vô hình thì không
 * dạy được ai hành vi tốt, nó chỉ làm người ta thấy hệ thống thất thường.
 */
export const postingStandingSchema = z
  .object({
    canSelfPublish: z.boolean().openapi({ description: 'Tin lên bảng ngay, không qua hàng đợi' }),
    /** Còn bao nhiêu tin được duyệt sạch nữa thì tự đăng được. `0` khi đã tự đăng được. */
    cleanApprovalsNeeded: z.number(),
    /** `null` = không bị phạt. Khác `null` = đang trong cửa sổ hậu-từ-chối. */
    penalty: z
      .object({
        rejections: z.number(),
        until: z.string().datetime(),
      })
      .nullable(),
  })
  .openapi('PostingStanding')

/**
 * Một tin cũ mà màn chặn-trước-khi-đăng đem ra hỏi. Rút gọn có chủ đích: chỉ đủ để vẽ một
 * dòng kèm hai nút "đã bán" / "vẫn còn", không phải bản sao của `Listing`.
 */
export const staleListingSchema = z
  .object({
    _id: objectId,
    title: z.string(),
    image: z.string().openapi({ description: 'Ảnh bìa; rỗng nếu tin không có ảnh nào' }),
    status: z.nativeEnum(LISTING_STATUS),
    expiresAt: z.coerce.date(),
  })
  .openapi('StaleListing')

export const quotaStatusSchema = z
  .object({
    allowed: z.boolean(),
    limit: z.number(),
    pending: z.number(),
    remaining: z.number(),
    reason: z.enum(['blocked_by_rejections', 'quota_full']).optional(),
    fee: postingFeeSchema,
    standing: postingStandingSchema,
    needsReconcile: z.array(staleListingSchema).openapi({
      description:
        'Tin đã hết hạn hoặc sắp hết hạn trong 7 ngày, cũ nhất trước, tối đa 20 tin. ' +
        'Client dùng để chặn lại và hỏi về tin cũ trước khi cho đăng tin mới.',
    }),
  })
  .openapi('QuotaStatus')

export const updateListingSchema = createListingSchema.partial().strict().openapi('UpdateListing')

export const postingStatsQuerySchema = z.object({
  /** Cửa sổ đo — 30 ngày là một chu kỳ đăng của người bán thường. */
  days: z.coerce.number().int().min(7).max(365).default(30),
})

export const postingStatsSchema = z
  .object({
    totalPosts: z.number(),
    distinctPosters: z.number(),
    byCategory: z.array(z.object({ _id: z.string(), count: z.number() })),
    posterHistogram: z.array(
      z.object({ _id: z.union([z.number(), z.string()]), users: z.number() }),
    ),
  })
  .openapi('PostingStats')

/**
 * Một ràng buộc trên thuộc tính động. Ba dạng, phủ đủ mọi `FIELD_TYPE`:
 * - `"honda"` / `true` / `2019` — bằng đúng (select, boolean, text)
 * - `["honda","yamaha"]` — thuộc tập (multiselect, hoặc chọn nhiều giá trị của select)
 * - `{ gte, lte }` — khoảng (number, year)
 */
const attrConstraintSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()).min(1).max(20),
  z
    .object({ gte: z.number().optional(), lte: z.number().optional() })
    .strict()
    .refine((r) => r.gte !== undefined || r.lte !== undefined, 'Khoảng phải có gte hoặc lte'),
])

export const listingQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  q: z.string().optional(),
  category: objectId.optional(),
  seller: objectId.optional(),
  province: z.enum(VN_PROVINCE_NAMES).optional(),
  condition: z.nativeEnum(LISTING_CONDITION).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  /**
   * Lọc theo thuộc tính động, JSON đã url-encode: `?attrs={"brand":"honda","seats":{"gte":7}}`.
   *
   * JSON chứ không phải một cú pháp rút gọn tự chế (`brand:honda|seats:7..`): kiểu giá trị ở
   * đây có cả số, boolean, mảng và khoảng — mã hoá tay là tự viết một parser nữa để rồi đoán
   * nhầm `"true"` là chuỗi hay boolean.
   *
   * `.catch()` KHÔNG dùng: JSON hỏng phải ra 400 chứ không âm thầm bỏ bộ lọc rồi trả về cả kho.
   */
  attrs: z
    .string()
    .max(2000)
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`attrs` không phải JSON hợp lệ' })
        return z.NEVER
      }
    })
    .pipe(z.record(attrConstraintSchema).refine((o) => Object.keys(o).length <= 12))
    .optional(),
})

export type AttrQuery = z.infer<typeof attrConstraintSchema>

/**
 * "Gần đây" = cùng địa giới hành chính, không phải cùng bán kính. `ward` chỉ để XẾP TRƯỚC
 * chứ không lọc cứng: lọc cứng theo xã thì ở xã thưa tin người dùng nhận màn rỗng, trong khi
 * tin ở xã bên cạnh vẫn là thứ họ muốn thấy.
 */
export const nearbyQuerySchema = z.object({
  province: z.enum(VN_PROVINCE_NAMES).openapi({ example: 'Hồ Chí Minh' }),
  ward: z.string().max(100).optional().openapi({ example: 'Phường Bến Thành' }),
  /** Id tin đang xem — để nó không tự xuất hiện trong danh sách "tin gần đây" của chính nó. */
  exclude: objectId.optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const listingParamsSchema = z.object({ id: objectId })

// passthrough: model còn field khác và có thể thêm nữa — doc không nên là bản sao
// phải sửa tay mỗi lần listing.model.ts đổi.
export const listingResponseSchema = z
  .object({
    _id: objectId,
    /** `null` = tin của trục danh mục, không thuộc tổ chức nào. */
    organizationId: objectId.nullable(),
    visibility: z.nativeEnum(POST_VISIBILITY),
    provinceCode: z.string(),
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    price: z.number(),
    isNegotiable: z.boolean(),
    condition: z.nativeEnum(LISTING_CONDITION),
    images: z.array(z.string().url()),
    category: objectId,
    seller: objectId,
    posterName: z.string().openapi({ description: 'Snapshot tên người đăng lúc tạo tin' }),
    posterContact: z.string().openapi({ description: 'Snapshot liên hệ công khai lúc tạo tin' }),
    posterAvatar: z.string().openapi({ description: 'Snapshot ảnh đại diện lúc tạo tin' }),
    location: locationSchema.optional(),
    /** Đã ép kiểu theo template — số là số, boolean là boolean. Xem `CreateListing.attributes`. */
    attributes: z.record(z.unknown()).optional(),
    /** Bản template lúc tạo tin. Form sửa tin phải nạp ĐÚNG version này, không phải bản mới nhất. */
    templateRef: z
      .object({ id: objectId, version: z.number(), isFallback: z.boolean() })
      .optional(),
    status: z.nativeEnum(LISTING_STATUS),
    viewCount: z.number(),
    favoriteCount: z.number(),
    expiresAt: z.string().datetime().optional(),
    rankAt: z.string().datetime().optional(),
    featuredUntil: z.string().datetime().nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .openapi('Listing')

export type CreateListingInput = z.infer<typeof createListingSchema>
export type UpdateListingInput = z.infer<typeof updateListingSchema>
export type ListingQuery = z.infer<typeof listingQuerySchema>
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>

registry.register('CreateListing', createListingSchema)
registry.register('PostingFee', postingFeeSchema)
registry.register('PostingStanding', postingStandingSchema)
registry.register('StaleListing', staleListingSchema)
registry.register('QuotaStatus', quotaStatusSchema)
registry.register('PostingStats', postingStatsSchema)
registry.register('UpdateListing', updateListingSchema)
registry.register('Listing', listingResponseSchema)
