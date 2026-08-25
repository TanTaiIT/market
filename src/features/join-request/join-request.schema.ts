import { z } from 'zod'
import { registry } from '../../config/openapi'
import { JOIN_REQUEST_STATUS } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/*
 * Nhận MÃ NHÓM chứ không nhận slug hay id.
 *
 * Slug là địa chỉ công khai: ai nhìn thấy tên tổ chức cũng gõ được đơn xin vào. Mã nhóm chỉ
 * người được đưa mới có, và đổi được khi rò — hai tính chất mà slug không thể có, vì nó nằm
 * trong mọi đường dẫn đã phát ra ngoài.
 */
/**
 * Hai đường vào nhóm, và chúng KHÔNG tương đương:
 *
 * - `code`: đường cũ, dùng được với MỌI nhóm. Mã do nhóm phát ra nên nhóm kiểm soát được ai
 *   đủ điều kiện gõ cửa, và xoay lại được khi mã lọt ra ngoài.
 * - `slug`: chỉ dùng được với nhóm `isPublic`. Nhóm công khai vốn đã cho duyệt và cho xem
 *   hồ sơ, nên bắt thêm một cái mã ở bước cuối chỉ là thủ tục thừa.
 *
 * Nhóm RIÊNG TƯ gửi bằng slug sẽ nhận 404 y như slug không tồn tại — nếu không, đường này
 * thành máy dò: gửi thử slug rồi đọc mã lỗi là biết nhóm nào có thật.
 */
export const createJoinRequestSchema = z
  .object({
    code: z.string().min(4).max(16).optional(),
    slug: z.string().min(3).max(40).optional(),
    claimedName: z.string().min(1).max(100).openapi({ example: 'Nguyễn Văn A' }),
    claimedUnit: z.string().max(100).optional().openapi({ example: '10A1' }),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.slug), 'Gửi đúng một trong hai: code hoặc slug')
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
