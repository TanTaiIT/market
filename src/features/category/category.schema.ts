import { z } from 'zod'
import { registry } from '../../config/openapi'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const categorySlugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug chỉ gồm a-z, 0-9 và dấu gạch ngang')

export const categoryQuerySchema = z.object({
  // Mặc định chỉ trả danh mục đang bật: app người dùng dựng chip lọc từ đây, danh mục đã
  // tắt hiện lên sẽ dẫn tới màn rỗng. Bàn quản trị mới cần thấy cả hai.
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

export const categoryParamsSchema = z.object({ id: objectId })

export const createCategorySchema = z
  .object({
    name: z.string().min(2).max(60).openapi({ example: 'Sách vở' }),
    // Bỏ trống thì service tự sinh từ `name`.
    slug: categorySlugSchema.optional(),
    icon: z.string().max(8).optional().openapi({ example: '📚' }),
    order: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('CreateCategory')

export const updateCategorySchema = z
  .object({
    name: z.string().min(2).max(60).optional(),
    icon: z.string().max(8).optional(),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateCategory')

export const categoryResponseSchema = z
  .object({
    id: objectId,
    name: z.string(),
    slug: z.string(),
    icon: z.string(),
    order: z.number(),
    isActive: z.boolean(),
  })
  .openapi('Category')

export type CategoryQuery = z.infer<typeof categoryQuerySchema>
export type CreateCategoryInput = z.infer<typeof createCategorySchema>
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>

registry.register('CreateCategory', createCategorySchema)
registry.register('UpdateCategory', updateCategorySchema)
registry.register('Category', categoryResponseSchema)
