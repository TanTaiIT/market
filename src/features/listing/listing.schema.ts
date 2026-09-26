import { z } from 'zod'
import { cloudinaryImageUrl } from '../../common/utils/imageUrl'
import { registry } from '../../config/openapi'
import {
  LISTING_STATUS,
  REPORT_GRANULARITY,
  LISTING_CONDITION,
  LISTING_REACH,
  VN_PROVINCE_NAMES,
  isWardOfProvince,
  PAGINATION,
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
    /** Người bán nhận giao tận nơi. Bỏ trống = không — xem `default` ở model. */
    canDeliver: z.boolean().optional(),
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
     * Bậc phủ sóng — xem `LISTING_REACH`. Bỏ trống thì service tính bằng `defaultReachFor`:
     * nhóm công khai → `group_open`, nhóm kín → `members`, không nhóm → `marketplace`.
     *
     * Không đặt mặc định ở đây được: nó phụ thuộc `isPublic` của nhóm đích, thứ schema tĩnh
     * không nhìn thấy.
     */
    reach: z.nativeEnum(LISTING_REACH).optional(),
    /**
     * Tỉnh quyết định AI DUYỆT ở bậc `marketplace`, nên nó tách khỏi `location` (vốn tuỳ chọn
     * và chỉ để hiển thị/lọc). Bỏ trống thì lấy `location.province`, rồi tới tỉnh của tổ chức.
     */
    provinceCode: z.enum(VN_PROVINCE_NAMES).optional(),
    /**
     * Chỉ dùng khi người đăng KHÔNG thuộc tổ chức đích (đường lùi "người ngoài đề xuất").
     * Thành viên không cần gửi: org của họ đến từ scope, và scope thì đã đối chiếu membership.
     */
    orgId: objectId.optional(),
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

/** `GET /listings/quota` — danh mục để tính quota trục công khai; bỏ trống là quota nội bộ. */
export const quotaQuerySchema = z.object({ categoryId: objectId.optional() })

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

/**
 * Sửa tin — LIỆT KÊ TƯỜNG MINH, không phải `createListingSchema.partial()`.
 *
 * Bản cũ là `.partial()` của schema tạo, nên `reach`, `provinceCode` và `orgId` cũng sửa
 * được. Ba field đó là KHOÁ ĐỊNH TUYẾN: `routeListing` đọc chúng đúng một lần lúc tạo để chọn
 * hàng đợi duyệt. Cho sửa sau là mở một đường leo thang có thật — `service.update` đổ thẳng
 * `...rest` vào document, còn `touchesReviewedContent` chỉ soi tiêu đề/mô tả/giá/danh mục/ảnh
 * nên `status` không hề bị đặt lại:
 *
 *   đăng bậc `members` → nhóm mình duyệt → PATCH `{"reach":"marketplace"}`
 *   → tin nằm ACTIVE trên bảng tin chung, chưa từng qua manager danh mục.
 *
 * `provinceCode` cùng dạng: đổi nó là đổi luôn bàn duyệt của tin.
 *
 * Muốn đổi đích đến sau khi đăng thì phải là một route riêng chạy lại `routeListing` và xếp
 * hàng lại — không phải một field trong bản vá này.
 *
 * ── CỬA SAU ĐÃ BỊT: `location` ──────────────────────────────────────────────
 *
 * Loại `provinceCode` ra là chưa đủ, vì `location.province` đi vào đây bằng cửa khác và nó
 * chính là NGUỒN mà `resolveProvinceCode` dựng `provinceCode` lúc tạo. Hệ quả trước bản này:
 *
 *   đăng tin ở Cà Mau → duyệt xong → PATCH `{"location":{"province":"Hồ Chí Minh",...}}`
 *   → tin hiện và tìm được ở HCM (`location.province`), nhưng ô duyệt vẫn là Cà Mau
 *     (`provinceCode` không ai cập nhật), và `touchesReviewedContent` không soi location
 *     nên tin còn chẳng bị xếp hàng lại.
 *
 * Nên bản vá chỉ nhận `address` — số nhà / tên đường, thứ KHÔNG tham gia định tuyến. Tỉnh và
 * phường đóng băng sau khi đăng, đúng như `reach` và `provinceCode`.
 *
 * Cái giá, nói thẳng: chọn nhầm phường thì phải xoá tin đăng lại, mất lượt xem và một suất
 * quota. Đổi lại là không có đường nào để một tin đã duyệt lặng lẽ đổi địa bàn. Muốn cho sửa
 * thì đường đúng vẫn là route riêng chạy lại `routeListing` — như ghi chú trên đã nói.
 */
const updateLocationSchema = z
  .object({
    address: z.string().max(255).optional(),
  })
  .strict()
  .openapi('UpdateListingLocation')

export const updateListingSchema = createListingSchema
  .pick({
    title: true,
    description: true,
    price: true,
    isNegotiable: true,
    canDeliver: true,
    condition: true,
    categoryId: true,
    images: true,
    attributes: true,
  })
  .partial()
  .extend({ location: updateLocationSchema.optional() })
  .strict()
  .openapi('UpdateListing')

export const listingReportQuerySchema = z.object({
  granularity: z.nativeEnum(REPORT_GRANULARITY).default(REPORT_GRANULARITY.DAY),
  /*
   * Ngày dạng ISO, cả hai đều KHÔNG bắt buộc: thiếu thì service điền cửa sổ mặc định theo độ
   * mịn (30 ngày / 12 tháng / 5 năm). Bắt client tự tính hai mốc là bắt mỗi client tự định
   * nghĩa "tháng này", và hai client sẽ định nghĩa khác nhau.
   */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

export const listingReportSchema = z
  .object({
    granularity: z.nativeEnum(REPORT_GRANULARITY),
    from: z.string().datetime(),
    to: z.string().datetime(),
    /** Múi giờ đã dùng để gộp cột — client hiện ra để không ai hiểu nhầm "ngày" là ngày máy họ. */
    timezone: z.string(),
    /** Số cột bị cắt vì vượt trần; `0` = không cắt gì. */
    truncated: z.number(),
    points: z.array(
      z.object({
        /** Nhãn cột: `2026-09-08` | `2026-09` | `2026`. Cột rỗng vẫn có mặt với số 0. */
        bucket: z.string(),
        posts: z.number(),
        /** Số người bán KHÁC NHAU trong cột — khác hẳn `posts`. */
        sellers: z.number(),
        active: z.number(),
        pending: z.number(),
        rejected: z.number(),
      }),
    ),
    totals: z.object({
      posts: z.number(),
      active: z.number(),
      pending: z.number(),
      rejected: z.number(),
    }),
  })
  .openapi('ListingReport')

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

export const listingQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).optional(),
    q: z.string().optional(),
    category: objectId.optional(),
    seller: objectId.optional(),
    province: z.enum(VN_PROVINCE_NAMES).optional(),
    /**
     * Tầng hai của bộ lọc khu vực, dưới `province`. Không enum (cùng lý do với `ward` lúc đăng
     * tin); tính hợp lệ chốt ở `superRefine` bên dưới.
     */
    ward: z.string().max(100).optional().openapi({ example: 'Phường Bến Thành' }),
    condition: z.nativeEnum(LISTING_CONDITION).optional(),
    /**
     * Thu hẹp theo BẬC phủ sóng. LẶP LẠI được: `?reach=members&reach=group_open` là cách hồ sơ
     * nhóm xin "mọi thứ trong nhóm này", còn bảng tin chung xin đúng `?reach=marketplace`.
     *
     * Lặp khoá chứ không phải CSV: `qs` của Express đã dựng sẵn mảng, không phải tự viết parser,
     * và OpenAPI diễn đạt thẳng được bằng `style: form, explode: true`.
     *
     * Đây là bộ lọc, KHÔNG phải cửa hậu: `tenantPlugin` vẫn `$and` scope của nó lên trên, nên
     * tham số này chỉ thu hẹp chứ không mở thêm gì. Xin `members` của một nhóm mình không ở
     * trong thì ra rỗng.
     */
    reach: z
      .preprocess(
        (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
        z.array(z.nativeEnum(LISTING_REACH)).min(1).max(3),
      )
      .optional(),
    /**
     * Thu hẹp về tin của ĐÚNG một nhóm — đường của hồ sơ nhóm.
     *
     * Đây là thứ thay cho mẹo cũ "gửi `X-Org-Id` rồi ghim một giá trị visibility", và nó là
     * thứ DUY NHẤT phục vụ được cả hai loại người xem trên cùng một truy vấn: thành viên ăn
     * nhánh org nên thấy đủ tin của nhóm, người ngoài ăn nhánh công khai `AND organizationId`
     * nên thấy đúng phần nhóm đã mở ra. Header thì không làm được vế thứ hai — người ngoài
     * không có chỗ đứng nào trên trục org để mà thu hẹp.
     *
     * Chỉ THU HẸP, như `reach`: `tenantPlugin` vẫn `$and` scope lên trên.
     */
    orgId: objectId.optional(),
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
  /*
   * `ward` không bao giờ đứng một mình, và phải thuộc đúng tỉnh — cùng luật với
   * `createListingSchema`. Tên phường/xã lặp giữa các tỉnh ("Phường 1" có ở hàng chục nơi):
   * lọc xã trần là gộp kết quả của những nơi cách nhau nghìn cây số rồi gọi đó là "gần đây".
   * 400 chứ không âm thầm bỏ tham số: trang kết quả trắng vì một param lẻ thì không ai đoán ra.
   */
  .superRefine((q, ctx) => {
    if (!q.ward) return
    if (!q.province) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ward'],
        message: '`ward` phải đi kèm `province`',
      })
    } else if (!isWardOfProvince(q.province, q.ward)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ward'],
        message: `"${q.ward}" không thuộc ${q.province}`,
      })
    }
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
  limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).optional(),
})

export const listingParamsSchema = z.object({ id: objectId })

// passthrough: model còn field khác và có thể thêm nữa — doc không nên là bản sao
// phải sửa tay mỗi lần listing.model.ts đổi.
export const listingResponseSchema = z
  .object({
    _id: objectId,
    /** `null` = tin của trục danh mục, không thuộc tổ chức nào. */
    organizationId: objectId.nullable(),
    /**
     * Danh thiếp nhóm để hiện trên tin — `null` khi tin không thuộc nhóm nào, HOẶC khi nhóm
     * đó riêng tư / đang khoá / đã xoá.
     *
     * Vì thế `org: null` KHÔNG đồng nghĩa `organizationId: null`: một tin lên sàn mang tên một
     * nhóm riêng tư vẫn có `organizationId` (để nhóm gỡ được nó — xem `canTakedownListing`)
     * nhưng không có badge. Client đọc `org` để vẽ, đọc `organizationId` để phân quyền; lấy
     * cái này suy ra cái kia là sai ở đúng những ca đáng quan tâm.
     */
    org: z
      .object({
        id: objectId,
        name: z.string(),
        avatarUrl: z.string().nullable(),
      })
      .nullable()
      .optional(),
    reach: z.nativeEnum(LISTING_REACH),
    provinceCode: z.string(),
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    price: z.number(),
    isNegotiable: z.boolean(),
    canDeliver: z.boolean(),
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

/**
 * Lời giải thích cho chính chủ về trạng thái duyệt — đã là CÂU CHỮ, không phải mã.
 * Client hiện nguyên văn; mã hold/reason là chi tiết nội bộ và không nằm trong hợp đồng này.
 */
export const listingReviewSchema = z
  .object({
    state: z.enum(['pending', 'rejected', 'hidden']),
    title: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  })
  .openapi('ListingReview')

/**
 * `Listing` + `review`, CHỈ trả trên `/listings/mine*`. Không nới `Listing` chung: DTO đó ai
 * cũng đọc được, và lý do một tin bị giữ lại là chuyện giữa người đăng với người duyệt.
 */
export const ownerListingSchema = listingResponseSchema
  .extend({
    review: listingReviewSchema.optional().openapi({
      description: 'Vắng khi tin đang hiện / đã bán / hết hạn — không có gì cần giải thích.',
    }),
  })
  .openapi('OwnerListing')

export type ListingReviewDto = z.infer<typeof listingReviewSchema>
export type CreateListingInput = z.infer<typeof createListingSchema>
export type UpdateListingInput = z.infer<typeof updateListingSchema>
export type ListingReportQuery = z.infer<typeof listingReportQuerySchema>
export type ListingQuery = z.infer<typeof listingQuerySchema>
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>

registry.register('CreateListing', createListingSchema)
registry.register('PostingFee', postingFeeSchema)
registry.register('PostingStanding', postingStandingSchema)
registry.register('StaleListing', staleListingSchema)
registry.register('QuotaStatus', quotaStatusSchema)
registry.register('ListingReport', listingReportSchema)
registry.register('PostingStats', postingStatsSchema)
registry.register('UpdateListing', updateListingSchema)
registry.register('Listing', listingResponseSchema)
registry.register('OwnerListing', ownerListingSchema)
registry.register('ListingReview', listingReviewSchema)
