import { z } from 'zod'
import { registry } from '../../config/openapi'
import { JOINED_VIA, MEMBERSHIP_ROLES } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const membershipQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const memberResponseSchema = z
  .object({
    /** Khoá để gán nhóm con và cấp quyền — cả hai endpoint đó đều nhận `userId`, không nhận id membership. */
    userId: objectId,
    name: z.string(),
    avatar: z.string(),
    role: z.nativeEnum(MEMBERSHIP_ROLES),
    unitId: objectId.nullable(),
    // Ba field dưới CHỈ có khi người gọi là quản trị org. Khai `optional` thay vì dựng hai
    // schema: một union ở đây biến mọi call-site của SDK thành một lượt thu hẹp kiểu, cho một
    // khác biệt mà chính client đã biết trước khi gọi.
    joinedVia: z.nativeEnum(JOINED_VIA).optional(),
    trustLevel: z.number().optional(),
    joinedAt: z.string().datetime().optional(),
  })
  .openapi('Member')

export type MembershipQuery = z.infer<typeof membershipQuerySchema>

registry.register('Member', memberResponseSchema)
