import { z } from 'zod'
import { registry } from '../../config/openapi'
import { SUPPORT_BODY_MAX, SUPPORT_SIDE } from './support.model'

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const sendSupportSchema = z.object({
  body: z
    .string()
    .trim()
    .min(5, 'Viết rõ hơn một chút để đội ngũ hỗ trợ hiểu bạn cần gì')
    .max(SUPPORT_BODY_MAX),
})

export const supportParamsSchema = z.object({ id: objectId })

export const supportQueueQuerySchema = z.object({
  /**
   * Mặc định `true` — thứ master cần là danh sách VIỆC CHƯA LÀM, không phải kho lưu trữ mọi
   * cuộc trò chuyện từng có. Muốn xem hết thì gửi `waiting=false`.
   *
   * Enum chứ KHÔNG `z.coerce.boolean()`: query string luôn là chuỗi, mà `Boolean('false')`
   * ra `true` — bộ lọc sẽ im lặng làm ngược ý người gọi. Cùng khuôn đã dùng ở
   * `category.schema` và cùng cái bẫy đã ghi lại ở `notification.schema`.
   */
  waiting: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const supportMessageSchema = z.object({
  from: z.nativeEnum(SUPPORT_SIDE),
  body: z.string(),
  at: z.string().datetime(),
  byUserId: objectId,
})

export const myThreadSchema = z
  .object({
    /** `null` = chưa từng nhắn gì. Client vẫn nhận đúng hình dạng này, không phải 404. */
    id: objectId.nullable(),
    messages: z.array(supportMessageSchema),
    /** Có tin của master mà người dùng chưa đọc — đây là cái chấm đỏ trên icon hỗ trợ. */
    unread: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi('MySupportThread')

export const supportThreadSchema = z
  .object({
    id: objectId,
    userId: objectId,
    userName: z.string(),
    messages: z.array(supportMessageSchema),
  })
  .openapi('SupportThread')

export const supportQueueItemSchema = z
  .object({
    id: objectId,
    userId: objectId,
    userName: z.string(),
    lastUserAt: z.string().datetime().nullable(),
    lastMasterAt: z.string().datetime().nullable(),
    /** Người dùng đã nhắn sau lần master xem gần nhất. */
    waiting: z.boolean(),
  })
  .openapi('SupportQueueItem')

export type SendSupportInput = z.infer<typeof sendSupportSchema>
export type SupportQueueQuery = z.infer<typeof supportQueueQuerySchema>

registry.register('MySupportThread', myThreadSchema)
registry.register('SupportThread', supportThreadSchema)
registry.register('SupportQueueItem', supportQueueItemSchema)
