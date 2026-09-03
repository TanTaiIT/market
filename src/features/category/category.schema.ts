import { z } from 'zod'
import { registry } from '../../config/openapi'
import { templateFieldInputSchema } from '../category-template/category-template.schema'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const categorySlugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug chỉ gồm a-z, 0-9 và dấu gạch ngang')

/**
 * Biểu tượng danh mục — BẮT BUỘC khi tạo.
 *
 * Bộ icon chuẩn nằm bên app (`CategoryIconPicker`), KHÔNG whitelist ở đây: khoá cứng danh sách
 * emoji vào schema nghĩa là thêm một icon phải deploy BE, và danh sách sẽ tồn tại hai bản ở hai
 * repo rồi lệch nhau. Chỗ này chỉ chốt điều BE thật sự bảo được: danh mục không được ra đời
 * trống biểu tượng — mọi bề mặt của app đều bày danh mục icon trước, tên sau.
 *
 * `max(8)` khớp `maxlength` của model: đủ cho emoji ghép ZWJ mà không thành chỗ nhét chuỗi.
 */
export const categoryIconSchema = z
  .string()
  .trim()
  .min(1, 'Danh mục phải có biểu tượng')
  .max(8)
  .openapi({ example: '📚' })

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
    icon: categoryIconSchema,
    order: z.number().int().min(0).optional(),
    requireManualReview: z.boolean().optional(),
    /**
     * Template đi kèm, tuỳ chọn. Có thì tạo luôn bản v1 và **phát hành ngay** — master tạo
     * danh mục là đã biết mình muốn form đăng tin trông thế nào.
     *
     * Bỏ trống vẫn hợp lệ: danh mục không có template riêng sẽ rơi về bản chung, và trước
     * tính năng này mọi danh mục đều như vậy.
     */
    template: z
      .object({ fields: z.array(templateFieldInputSchema).min(1).max(40) })
      .strict()
      .optional(),
  })
  .strict()
  .openapi('CreateCategory')

export const updateCategorySchema = z
  .object({
    name: z.string().min(2).max(60).optional(),
    // Sửa vẫn tuỳ chọn: đổi tên danh mục không phải là lý do bắt khai lại icon.
    icon: categoryIconSchema.optional(),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    requireManualReview: z.boolean().optional(),
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
    /** Tin trong danh mục này luôn qua người duyệt, bỏ qua mọi ngưỡng uy tín. */
    requireManualReview: z.boolean(),
  })
  .openapi('Category')

export type CategoryQuery = z.infer<typeof categoryQuerySchema>
export type CreateCategoryInput = z.infer<typeof createCategorySchema>
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>

registry.register('CreateCategory', createCategorySchema)
registry.register('UpdateCategory', updateCategorySchema)
registry.register('Category', categoryResponseSchema)
