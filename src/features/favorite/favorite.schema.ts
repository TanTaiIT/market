import { z } from 'zod'
import { registry } from '../../config/openapi'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const favoriteParamsSchema = z.object({ listingId: objectId })

export const favoriteQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * Kết quả của một lượt bấm tim. Trả lại trạng thái SAU thao tác chứ không phải "đã đổi hay
 * chưa": client chỉ cần biết cái tim giờ đầy hay rỗng, và câu trả lời đó đúng cả khi bấm lại
 * lần hai (idempotent).
 *
 * Không kèm `favoriteCount`: bỏ tim không đọc lại tin (tin có thể đã bị gỡ), nên con số đó sẽ
 * lúc có lúc không. Số lượt lưu đọc ở `Listing.favoriteCount` của chính tin.
 */
export const favoriteStatusSchema = z
  .object({
    listingId: objectId,
    favorited: z.boolean(),
  })
  .openapi('FavoriteStatus')

export type FavoriteQuery = z.infer<typeof favoriteQuerySchema>

registry.register('FavoriteStatus', favoriteStatusSchema)
