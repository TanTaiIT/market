import { z } from 'zod'
import { registry } from '../../config/openapi'
import { GENDER, VN_PROVINCE_NAMES, isWardOfProvince } from '../../common/constants'

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Khu vực của người dùng. Khai riêng ở đây, KHÔNG import từ `listing.schema.ts`: hai thứ trùng
 * hình dạng nhưng khác vòng đời — `Listing.location` quyết định ai duyệt tin, còn cái này chỉ
 * để điền sẵn form. Dùng chung một schema là buộc hai thứ đó phải đổi cùng nhau.
 */
const userLocationSchema = z
  .object({
    province: z.enum(VN_PROVINCE_NAMES).optional(),
    ward: z.string().max(100).optional(),
    address: z.string().max(255).optional(),
  })
  .strict()

/**
 * Bản có ràng buộc, **chỉ dùng cho ĐẦU VÀO**. Schema response giữ object thuần ở trên để
 * zod-to-openapi sinh ra `MeProfile` không kèm ràng buộc chỉ có nghĩa lúc ghi — đúng cách
 * `listing.schema.ts` tách `locationSchema` / `locationInputSchema`.
 */
const userLocationInputSchema = userLocationSchema.superRefine((loc, ctx) => {
  // Cùng chốt như tin đăng: `{ province: 'Hà Nội', ward: 'Phường Vũng Tàu' }` lưu được thì
  // form đăng tin sẽ điền sẵn một cái xã không tồn tại trong tỉnh đó.
  if (loc.province && loc.ward && !isWardOfProvince(loc.province, loc.ward)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ward'],
      message: `"${loc.ward}" không thuộc ${loc.province}`,
    })
  }
})

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    /**
     * `''` = **xoá số điện thoại**, và đó là lý do có `.or(z.literal(''))`.
     *
     * Thiếu vế này thì `min(8)` từ chối chuỗi rỗng, nên người dùng chưa từng đặt SĐT không lưu
     * được BẤT KỲ field nào khác — form gửi `phone: ''` và cả lượt lưu ăn 400.
     */
    phone: z.string().min(8).max(15).or(z.literal('')).optional(),
    avatar: z.string().url().or(z.literal('')).optional(),
    gender: z.nativeEnum(GENDER).optional(),
    /** `{}` = xoá khu vực đã lưu. Không ai lọc theo `User.location` nên subdoc rỗng vô hại. */
    location: userLocationInputSchema.optional(),
    /** Bật = đồng ý cho hiện SĐT trên tin đăng MỚI. Xem `IUser.showPhone`. */
    showPhone: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateProfile')

// SoT của public profile: user.types.ts derive type từ đây. Cố tình KHÔNG có
// email/phone/isEmailVerified/lastLoginAt vì GET /users/:id không cần đăng nhập.
export const publicProfileSchema = z
  .object({
    id: objectId,
    name: z.string(),
    avatar: z.string(),
    /**
     * Công khai theo quyết định sản phẩm. `location` thì KHÔNG — nó ở lại `MeProfile`, vì địa
     * chỉ nhà công khai trên chợ đồ cũ là rủi ro an toàn cho người bán.
     */
    gender: z.nativeEnum(GENDER),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    createdAt: z.string().datetime(),
  })
  .openapi('PublicProfile')

/**
 * Trước đây schema này `passthrough` và controller trả nguyên document. Hệ quả: khi model bỏ
 * cột `role`, schema vẫn khai `role: z.string()`, SDK sinh ra `role: string`, và app gọi
 * `profile.role.trim()` trên `undefined`. Không có gì bắt được vì chẳng ai đối chiếu hai bên.
 *
 * Nên giờ nó là whitelist đi qua `toMeProfileDto` — đúng cách `publicProfileSchema` đã làm.
 * Vai trò KHÔNG nằm ở đây: nó là quan hệ (`memberships.role`, `role_grants.role`), đọc qua
 * `/organizations/mine` và `/role-grants/mine`.
 */
export const meProfileSchema = publicProfileSchema
  .extend({
    email: z.string().email(),
    phone: z.string().optional(),
    /** Chỉ chủ hồ sơ thấy — dùng để điền sẵn khu vực lúc đăng tin. */
    location: userLocationSchema.optional(),
    showPhone: z.boolean(),
    isEmailVerified: z.boolean(),
    isActive: z.boolean(),
  })
  .openapi('MeProfile')

export const userParamsSchema = z.object({ id: objectId })

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>

registry.register('UpdateProfile', updateProfileSchema)
registry.register('PublicProfile', publicProfileSchema)
registry.register('MeProfile', meProfileSchema)
