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

// ── ĐƯỜNG GHI (master) ──────────────────────────────────────────────────────

/**
 * `key` là khoá trong `Listing.attributes` và **không bao giờ đổi được** sau khi có tin dùng
 * nó. Ép camelCase ASCII ngay từ đầu vào: `Độ chai pin` hay `battery-health` lọt vào đây là
 * một khoá dị dạng nằm lại trong DB vĩnh viễn.
 */
const fieldKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-zA-Z0-9]*$/, 'key phải là camelCase ASCII, bắt đầu bằng chữ thường')

/**
 * Định nghĩa một field MỚI cho từ điển, khai ngay trong lúc dựng template.
 *
 * Bắt khai đủ ở đây thay vì cho tạo field trống rồi sửa sau: field thiếu `label` hay thiếu
 * `options` sẽ hiện ra form đăng tin dưới dạng một ô không ai biết phải điền gì.
 */
export const fieldDefinitionInputSchema = z
  .object({
    label: z.string().min(1).max(120).openapi({ example: 'Độ chai pin' }),
    type: z.nativeEnum(FIELD_TYPE),
    unit: z.string().max(20).optional().openapi({ example: '%' }),
    min: z.number().optional(),
    max: z.number().optional(),
    filterable: z.boolean().default(false),
    options: z.array(fieldOptionSchema).max(200).default([]),
    placeholder: z.string().max(120).optional(),
    helpText: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const needsOptions = input.type === FIELD_TYPE.SELECT || input.type === FIELD_TYPE.MULTISELECT
    if (needsOptions && input.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Field kiểu select/multiselect phải có ít nhất một lựa chọn',
      })
    }
  })
  .openapi('FieldDefinitionInput')

export const createFieldDefinitionSchema = fieldDefinitionInputSchema
  .innerType()
  .extend({ key: fieldKeySchema })
  .strict()
  .openapi('CreateFieldDefinition')

/**
 * Một dòng trong template. `define` chỉ cần khi `key` chưa có trong từ điển — hệ thống tự thêm
 * vào đó, nên master dựng xong một danh mục trong đúng một lượt gọi.
 */
export const templateFieldInputSchema = z
  .object({
    key: fieldKeySchema,
    order: z.number().int().min(0).max(10_000),
    required: z.boolean().default(false),
    /** Bỏ trống = theo từ điển. Khác hẳn `false`, nên KHÔNG đặt default. */
    filterable: z.boolean().optional(),
    group: z.string().max(60).optional(),
    showIf: showIfSchema.optional(),
    override: z
      .object({
        label: z.string().max(120).optional(),
        type: z.nativeEnum(FIELD_TYPE).optional(),
        options: z.array(fieldOptionSchema).max(200).optional(),
        placeholder: z.string().max(120).optional(),
        helpText: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    define: fieldDefinitionInputSchema.optional(),
  })
  .strict()
  .openapi('TemplateFieldInput')

export const templateFieldsSchema = z
  .object({ fields: z.array(templateFieldInputSchema).min(1).max(40) })
  .strict()
  .openapi('TemplateFields')

export const templateVersionParamsSchema = z.object({
  id: objectId,
  version: z.coerce.number().int().positive(),
})

export const fieldDefinitionSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.nativeEnum(FIELD_TYPE),
    unit: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    filterable: z.boolean(),
    options: z.array(fieldOptionSchema),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .openapi('FieldDefinition')

export type FieldDefinitionInput = z.infer<typeof fieldDefinitionInputSchema>
export type CreateFieldDefinitionInput = z.infer<typeof createFieldDefinitionSchema>
export type TemplateFieldInput = z.infer<typeof templateFieldInputSchema>
export type TemplateFieldsInput = z.infer<typeof templateFieldsSchema>

registry.register('FieldDefinitionInput', fieldDefinitionInputSchema)
registry.register('CreateFieldDefinition', createFieldDefinitionSchema)
registry.register('TemplateFieldInput', templateFieldInputSchema)
registry.register('TemplateFields', templateFieldsSchema)
registry.register('FieldDefinition', fieldDefinitionSchema)
