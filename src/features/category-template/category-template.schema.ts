import { z } from 'zod'
import { registry } from '../../config/openapi'
import { FIELD_TYPE } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const templateParamsSchema = z.object({ id: objectId })

/**
 * `version` để form SỬA TIN dựng lại đúng bộ field mà tin đó được tạo ra với nó — bỏ trống là
 * lấy bản đang phục vụ. Version không tồn tại thì rơi về bản mới nhất, không phải 404: sửa tin
 * bằng một form hơi lệch vẫn tốt hơn là không sửa được.
 */
export const templateQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
})

const fieldOptionSchema = z
  .object({
    value: z.string().openapi({ example: 'like_new' }),
    label: z.string().openapi({ example: 'Như mới (99%)' }),
  })
  .openapi('FieldOption')

/**
 * Điều kiện hiện field. `eq` HOẶC `in`, không bao giờ cả hai — FE và BE đều đọc `in` trước
 * (`isFieldVisible`), nên khai cả hai là để lại một nhánh không ai chạy tới.
 */
const showIfSchema = z
  .object({
    key: z.string(),
    eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z.array(z.string()).optional(),
  })
  .openapi('FieldShowIf')

/**
 * Một field ĐÃ GHÉP giữa từ điển và template — đây là thứ FE nhận, không phải hai mảnh rời.
 * Xem `toTemplateDto` để biết field nào đến từ đâu.
 */
export const templateFieldResponseSchema = z
  .object({
    key: z.string().openapi({ example: 'batteryHealth' }),
    label: z.string().openapi({ example: 'Độ chai pin' }),
    type: z.nativeEnum(FIELD_TYPE),
    options: z.array(fieldOptionSchema),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
    unit: z.string().optional().openapi({ example: '%' }),
    min: z.number().optional(),
    max: z.number().optional(),
    order: z.number().openapi({ description: 'Cách nhau 10 để sau chèn giữa được' }),
    required: z.boolean(),
    filterable: z.boolean(),
    group: z.string().optional().openapi({ example: 'Cấu hình' }),
    showIf: showIfSchema.optional(),
  })
  .openapi('TemplateField')

export const templateResponseSchema = z
  .object({
    /** `null` = hệ thống chưa seed template nào; danh mục không có thuộc tính động. */
    templateId: objectId.nullable(),
    version: z.number(),
    /** `true` = danh mục này chưa có template riêng, đang dùng bản chung 4 field. */
    isFallback: z.boolean(),
    fields: z.array(templateFieldResponseSchema),
  })
  .openapi('CategoryTemplate')

export type TemplateQuery = z.infer<typeof templateQuerySchema>

registry.register('FieldOption', fieldOptionSchema)
registry.register('FieldShowIf', showIfSchema)
registry.register('TemplateField', templateFieldResponseSchema)
registry.register('CategoryTemplate', templateResponseSchema)
