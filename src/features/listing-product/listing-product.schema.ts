import { z } from 'zod'
import { PRODUCT_EFFECTS } from '../listing/listing.pricing'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

export const listingProductParamsSchema = z.object({ id: objectId })

/** Giá nhận từ master chỉ có `amount` — currency do server đóng đinh `xu`, client không chọn. */
const priceInputSchema = z
  .object({ amount: z.number().int().nonnegative().openapi({ example: 5 }) })
  .strict()

/**
 * Zod chỉ chốt HÌNH của từng field. Luật xuyên field (đẩy tin không có thời hạn, mở bán phải
 * có giá…) nằm ở `productRuleErrors` trong service — update là PATCH nên phải ghép với bản
 * đang lưu rồi mới kiểm được, đặt luật ở đây là chỉ che được đường create.
 */
export const createListingProductSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{2,40}$/, 'Code chỉ gồm a-z, 0-9, _ (2–40 ký tự)')
      .openapi({ example: 'featured_7d_sale' }),
    name: z.string().trim().min(2).max(100).openapi({ example: 'Tin nổi bật 7 ngày — ưu đãi' }),
    description: z.string().trim().max(300).optional(),
    effect: z.enum(PRODUCT_EFFECTS),
    durationDays: z.number().int().min(1).max(365).nullable().optional(),
    cooldownHours: z.number().int().min(1).max(720).nullable().optional(),
    price: priceInputSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .openapi('CreateListingProduct')

/** `code` vắng mặt CÓ CHỦ ĐÍCH: nó là định danh mà sổ cái tương lai tham chiếu — bất biến. */
export const updateListingProductSchema = createListingProductSchema
  .omit({ code: true })
  .partial()
  .strict()
  .openapi('UpdateListingProduct')

export type CreateListingProductInput = z.infer<typeof createListingProductSchema>
export type UpdateListingProductInput = z.infer<typeof updateListingProductSchema>

export const listingProductResponseSchema = z
  .object({
    _id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    effect: z.enum(PRODUCT_EFFECTS),
    durationDays: z.number().nullable(),
    cooldownHours: z.number().nullable(),
    price: z.object({ amount: z.number(), currency: z.literal('xu') }).nullable(),
    enabled: z.boolean(),
    order: z.number(),
    createdAt: z.string().datetime(),
  })
  .openapi('ListingProduct')
