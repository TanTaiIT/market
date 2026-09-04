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
    role: z.nativeEnum(SYSTEM_ROLES),
    scopeType: z.nativeEnum(SCOPE_TYPES),
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

export type CreateRoleGrantInput = z.infer<typeof createRoleGrantSchema>

registry.register('CreateRoleGrant', createRoleGrantSchema)
registry.register('RoleGrant', roleGrantResponseSchema)
