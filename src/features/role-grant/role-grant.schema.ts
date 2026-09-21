import { z } from 'zod'
import { registry } from '../../config/openapi'
import { SYSTEM_ROLES, SCOPE_TYPES } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const roleGrantParamsSchema = z.object({ id: objectId })

/**
 * Hình dạng scope (field nào bắt buộc theo `scopeType`) do MODEL kiểm, không lặp lại ở đây:
 * một luật nằm ở hai chỗ là một luật sẽ lệch. Zod chỉ lo kiểu và giới hạn.
 *
 * Người nhận tới bằng `userId` khi người cấp chọn được từ danh bạ, bằng `userEmail` khi không:
 * manager trục (danh mục × tỉnh) thường chẳng thuộc tổ chức nào, mà `GET /memberships` đòi
 * hoặc tư cách thành viên hoặc quyền quản CHÍNH org đó — grant trục danh mục không phải cái
 * nào trong hai, nên với họ danh bạ vĩnh viễn rỗng. Đúng MỘT trong hai, vì hai định danh
 * gửi cùng lúc có thể trỏ hai người khác nhau và không có luật nào nói cái nào thắng.
 */
export const createRoleGrantSchema = z
  .object({
    userId: objectId.optional(),
    userEmail: z.string().trim().email().max(160).optional(),
    /**
     * Không còn `staff`: hệ thống bỏ tầng cấp phó, chỉ còn quản trị do master đặt. `master` vẫn
     * nằm trong enum để policy trả 403 có lý do (không ai cấp được master), thay vì 400 mơ hồ.
     */
    role: z.enum([SYSTEM_ROLES.MASTER, SYSTEM_ROLES.MANAGER], {
      message: 'Vai trò staff đã bỏ — hệ thống không còn cấp phó, chỉ còn Quản lý do master đặt',
    }),
    // `org_unit` chỉ từng có nghĩa với `staff` — đi theo nó.
    scopeType: z.enum([
      SCOPE_TYPES.SYSTEM,
      SCOPE_TYPES.ORG,
      SCOPE_TYPES.CATEGORY_PROVINCE,
      SCOPE_TYPES.CATEGORY_WARD,
    ]),
    orgId: objectId.optional(),
    unitId: objectId.optional(),
    categoryId: objectId.optional(),
    /** Rỗng/bỏ trống = toàn quốc. Chỉ có nghĩa với scope `category_province`. */
    provinceCodes: z.array(z.string().min(1).max(60)).max(40).optional(),
    /** Chỉ có nghĩa với scope `category_ward`; đi kèm đúng một tỉnh ở `provinceCodes`. */
    wardCodes: z.array(z.string().min(1).max(120)).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Boolean(input.userId) === Boolean(input.userEmail)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userId'],
        message: 'Cần đúng một trong hai: userId hoặc userEmail',
      })
    }
  })
  .openapi('CreateRoleGrant')

/**
 * Sửa PHẠM VI của một grant trục danh mục — thay toàn bộ, không vá từng field.
 *
 * Không nhận `userId` lẫn `role`: đổi người hoặc đổi vai là một grant KHÁC, và đi qua
 * cấp/thu hồi để hai chốt `canGrant` và `usableOrgAdmins` còn chạy. Ở đây chỉ đổi "phụ trách
 * ô nào".
 *
 * Thay toàn bộ vì hạ từ tầng phường xuống tầng tỉnh bắt buộc phải xoá `wardCodes` — một PATCH
 * bán phần khiến việc đó thành thao tác dễ quên nhất trong form, và kết quả là một grant tầng
 * tỉnh còn dính danh sách phường vô nghĩa.
 */
export const updateRoleGrantSchema = z
  .object({
    scopeType: z.enum([SCOPE_TYPES.CATEGORY_PROVINCE, SCOPE_TYPES.CATEGORY_WARD]),
    categoryId: objectId,
    /** Rỗng = TOÀN QUỐC, và chỉ hợp lệ với `category_province`. */
    provinceCodes: z.array(z.string().min(1).max(60)).max(40).default([]),
    /** Chỉ có nghĩa với `category_ward`; hình dạng do model kiểm (`enforceScopeShape`). */
    wardCodes: z.array(z.string().min(1).max(120)).max(200).default([]),
  })
  .strict()
  .openapi('UpdateRoleGrant')

/** Bộ lọc của bảng "ai phụ trách danh mục nào". Bỏ trống = liệt kê tất cả. */
export const categoryAxisQuerySchema = z.object({
  categoryId: objectId.optional(),
  /** Tên tỉnh như BE lưu. Grant toàn quốc (`provinceCodes` rỗng) LUÔN khớp mọi tỉnh. */
  province: z.string().min(1).max(60).optional(),
})

export const roleGrantResponseSchema = z
  .object({
    id: objectId,
    userId: objectId,
    role: z.nativeEnum(SYSTEM_ROLES),
    scopeType: z.nativeEnum(SCOPE_TYPES),
    orgId: objectId.nullable(),
    unitId: objectId.nullable(),
    categoryId: objectId.nullable(),
    provinceCodes: z.array(z.string()),
    wardCodes: z.array(z.string()),
    grantedBy: objectId.nullable(),
    grantedAt: z.string().datetime(),
  })
  .openapi('RoleGrant')

/**
 * Một dòng của bảng phụ trách: grant + danh tính người giữ + tên danh mục.
 *
 * Có `id` vì đó là thứ duy nhất `DELETE /role-grants/:id` nhận — thiếu nó thì bảng chỉ để
 * nhìn, và việc cấp quyền vẫn là đường một chiều như trước.
 */
export const categoryAxisGrantSchema = roleGrantResponseSchema
  .extend({
    holderName: z.string(),
    holderEmail: z.string(),
    /** `false` = tài khoản đã khoá hoặc không còn — ô này trông như "đã có người" mà thực ra không. */
    holderActive: z.boolean(),
    categoryName: z.string(),
  })
  .openapi('CategoryAxisGrant')

export type CreateRoleGrantInput = z.infer<typeof createRoleGrantSchema>
export type UpdateGrantScopeInput = z.infer<typeof updateRoleGrantSchema>

registry.register('CreateRoleGrant', createRoleGrantSchema)
registry.register('UpdateRoleGrant', updateRoleGrantSchema)
registry.register('RoleGrant', roleGrantResponseSchema)
registry.register('CategoryAxisGrant', categoryAxisGrantSchema)
