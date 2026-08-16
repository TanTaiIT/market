import { z } from 'zod'
import { registry } from '../../config/openapi'
import { SYSTEM_ROLES, SCOPE_TYPES } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const roleGrantParamsSchema = z.object({ id: objectId })

/**
 * Hình dạng scope (field nào bắt buộc theo `scopeType`) do MODEL kiểm, không lặp lại ở đây:
 * một luật nằm ở hai chỗ là một luật sẽ lệch. Zod chỉ lo kiểu và giới hạn.
 */
export const createRoleGrantSchema = z
  .object({
    userId: objectId,
    role: z.nativeEnum(SYSTEM_ROLES),
    scopeType: z.nativeEnum(SCOPE_TYPES),
    orgId: objectId.optional(),
    unitId: objectId.optional(),
    categoryId: objectId.optional(),
    /** Rỗng/bỏ trống = toàn quốc. Chỉ có nghĩa với scope `category_province`. */
    provinceCodes: z.array(z.string().min(1).max(60)).max(40).optional(),
  })
  .strict()
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
    grantedBy: objectId.nullable(),
    grantedAt: z.string().datetime(),
  })
  .openapi('RoleGrant')

export type CreateRoleGrantInput = z.infer<typeof createRoleGrantSchema>

registry.register('CreateRoleGrant', createRoleGrantSchema)
registry.register('RoleGrant', roleGrantResponseSchema)
