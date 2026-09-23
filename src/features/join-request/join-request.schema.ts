import { z } from 'zod'
import { registry } from '../../config/openapi'
import { JOIN_REQUEST_STATUS, PAGINATION } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Hai đường vào nhóm, và chúng KHÔNG tương đương:
 *
 * - `code`: dùng được với MỌI nhóm. Mã do nhóm phát ra nên nhóm kiểm soát được ai đủ điều
 *   kiện gõ cửa, và xoay lại được khi mã lọt ra ngoài — id của nhóm thì nằm trong mọi link đã
 *   phát và không đổi được.
 * - `orgId`: chỉ dùng được với nhóm `isPublic`. Nhóm công khai vốn đã cho duyệt và cho xem
 *   hồ sơ, nên bắt thêm một cái mã ở bước cuối chỉ là thủ tục thừa.
 *
 * Nhóm RIÊNG TƯ gửi bằng id sẽ nhận 404 y như id không tồn tại — nếu không, đường này thành
 * máy dò: gửi thử id rồi đọc mã lỗi là biết nhóm nào có thật.
 */
export const createJoinRequestSchema = z
  .object({
    code: z.string().min(4).max(16).optional(),
    orgId: objectId.optional(),
    claimedName: z.string().min(1).max(100).openapi({ example: 'Nguyễn Văn A' }),
    claimedUnit: z.string().max(100).optional().openapi({ example: '10A1' }),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.orgId), 'Gửi đúng một trong hai: code hoặc orgId')
  .openapi('CreateJoinRequest')

export const joinRequestParamsSchema = z.object({ id: objectId })

export const joinRequestQuerySchema = z.object({
  status: z.nativeEnum(JOIN_REQUEST_STATUS).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).optional(),
})

export type JoinRequestQuery = z.infer<typeof joinRequestQuerySchema>

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
