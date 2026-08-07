import { z } from 'zod'
import { registry } from '../../config/openapi'
import { NOTIFICATION_SOURCE } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const createNotificationSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
  })
  .strict()
  .openapi('CreateNotification')

export const notificationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const notificationParamsSchema = z.object({ id: objectId })

export const notificationResponseSchema = z
  .object({
    _id: objectId,
    organizationId: objectId,
    sourceType: z.nativeEnum(NOTIFICATION_SOURCE),
    sourceChainId: objectId.nullable(),
    title: z.string(),
    body: z.string(),
    readBy: z.array(objectId),
    createdAt: z.string().datetime(),
  })
  .passthrough()
  .openapi('Notification')

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>
export type NotificationQuery = z.infer<typeof notificationQuerySchema>

registry.register('CreateNotification', createNotificationSchema)
registry.register('Notification', notificationResponseSchema)
