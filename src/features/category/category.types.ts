import { z } from 'zod'
import { ICategoryDocument } from './category.model'
import { categoryResponseSchema } from './category.schema'

export type CategoryDto = z.infer<typeof categoryResponseSchema>

/**
 * Whitelist field thay vì trả nguyên document: `deletedAt`/`createdAt`/`updatedAt` là chuyện
 * nội bộ, và `_id` đổi tên thành `id` cho khớp mọi DTO còn lại (xem `toPublicProfileDto`).
 */
export function toCategoryDto(category: ICategoryDocument): CategoryDto {
  return {
    id: category._id.toString(),
    name: category.name,
    slug: category.slug,
    icon: category.icon,
    order: category.order,
    isActive: category.isActive,
    requireManualReview: category.requireManualReview,
  }
}
