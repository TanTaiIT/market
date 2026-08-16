import { z } from 'zod'
import { registry } from '../../config/openapi'
import { organizationSlugSchema } from '../organization/organization.schema'
import { JOIN_REQUEST_STATUS } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

// Nhận `orgSlug` chứ không nhận `organizationId`: người dùng vừa chọn org trên dropdown và
// slug là thứ họ nhìn thấy, id thì không. Slug cũng là thứ đã được xác nhận bằng tên đầy đủ.
export const createJoinRequestSchema = z
  .object({
    orgSlug: organizationSlugSchema,
    claimedName: z.string().min(1).max(100).openapi({ example: 'Nguyễn Văn A' }),
    claimedUnit: z.string().max(100).optional().openapi({ example: '10A1' }),
    note: z.string().max(500).optional(),
  })
  .strict()
  .openapi('CreateJoinRequest')

export const joinRequestParamsSchema = z.object({ id: objectId })

export const joinRequestQuerySchema = z.object({
  status: z.nativeEnum(JOIN_REQUEST_STATUS).optional(),
})

export const approveJoinRequestSchema = z
  .object({ unitId: objectId.nullable().optional() })
  .strict()
  .openapi('ApproveJoinRequest')

export const rejectJoinRequestSchema = z
  .object({ reason: z.string().max(300).optional() })
  .strict()
  .openapi('RejectJoinRequest')

export const bulkApproveSchema = z
  .object({
    items: z
      .array(z.object({ id: objectId, unitId: objectId.nullable().optional() }))
      .min(1)
      .max(200),
  })
  .strict()
  .openapi('BulkApproveJoinRequests')

export const joinRequestResponseSchema = z
  .object({
    id: objectId,
    userId: objectId,
    organizationId: objectId,
    claimedName: z.string(),
    claimedUnit: z.string().nullable(),
    note: z.string().nullable(),
    status: z.nativeEnum(JOIN_REQUEST_STATUS),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .openapi('JoinRequest')

/**
 * Bản trả cho CHÍNH người gửi — khác bản của hàng đợi: không có `userId` (thừa, họ là chính
 * mình) và có thêm `rejectReason`. Khai riêng vì đây là hợp đồng client sinh code từ đó;
 * dùng chung một schema cho hai hình dạng khác nhau là SDK sinh ra type sai.
 */
export const myJoinRequestResponseSchema = z
  .object({
    id: objectId,
    organizationId: objectId,
    claimedName: z.string(),
    claimedUnit: z.string().nullable(),
    status: z.nativeEnum(JOIN_REQUEST_STATUS),
    rejectReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .openapi('MyJoinRequest')

export type CreateJoinRequestInput = z.infer<typeof createJoinRequestSchema>
export type BulkApproveInput = z.infer<typeof bulkApproveSchema>

registry.register('CreateJoinRequest', createJoinRequestSchema)
registry.register('ApproveJoinRequest', approveJoinRequestSchema)
registry.register('RejectJoinRequest', rejectJoinRequestSchema)
registry.register('BulkApproveJoinRequests', bulkApproveSchema)
registry.register('JoinRequest', joinRequestResponseSchema)
registry.register('MyJoinRequest', myJoinRequestResponseSchema)
