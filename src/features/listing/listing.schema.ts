import { z } from 'zod'
import { registry } from '../../config/openapi'
import { LISTING_STATUS, LISTING_CONDITION } from '../../common/constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const locationSchema = z.object({
  coordinates: z
    .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .openapi({ description: '[longitude, latitude]', example: [106.700981, 10.776889] }),
  address: z.string().max(255).optional(),
  province: z.string().max(100).optional(),
  district: z.string().max(100).optional(),
})

export const createListingSchema = z
  .object({
    title: z.string().min(5).max(150).openapi({ example: 'Xe máy Honda Wave 2020' }),
    description: z.string().min(10).max(5000),
    price: z.number().nonnegative(),
    isNegotiable: z.boolean().optional(),
    condition: z.nativeEnum(LISTING_CONDITION).optional(),
    categoryId: objectId,
    images: z.array(z.string().url()).min(1).max(12),
    location: locationSchema,
    attributes: z.record(z.string()).optional(),
  })
  .strict()
  .openapi('CreateListing')

export const updateListingSchema = createListingSchema.partial().strict().openapi('UpdateListing')

export const listingQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  q: z.string().optional(),
  category: objectId.optional(),
  seller: objectId.optional(),
  province: z.string().optional(),
  condition: z.nativeEnum(LISTING_CONDITION).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
})

export const nearbyQuerySchema = z.object({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  maxDistance: z.coerce.number().positive().max(50000).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

export const listingParamsSchema = z.object({ id: objectId })

// passthrough: model còn field khác và có thể thêm nữa — doc không nên là bản sao
// phải sửa tay mỗi lần listing.model.ts đổi.
export const listingResponseSchema = z
  .object({
    _id: objectId,
    organizationId: objectId,
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    price: z.number(),
    isNegotiable: z.boolean(),
    condition: z.nativeEnum(LISTING_CONDITION),
    images: z.array(z.string().url()),
    category: objectId,
    seller: objectId,
    posterName: z.string().openapi({ description: 'Snapshot tên người đăng lúc tạo tin' }),
    posterContact: z.string().openapi({ description: 'Snapshot liên hệ công khai lúc tạo tin' }),
    location: locationSchema.extend({ type: z.literal('Point') }),
    status: z.nativeEnum(LISTING_STATUS),
    viewCount: z.number(),
    favoriteCount: z.number(),
    expiresAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .openapi('Listing')

export type CreateListingInput = z.infer<typeof createListingSchema>
export type UpdateListingInput = z.infer<typeof updateListingSchema>
export type ListingQuery = z.infer<typeof listingQuerySchema>
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>

registry.register('CreateListing', createListingSchema)
registry.register('UpdateListing', updateListingSchema)
registry.register('Listing', listingResponseSchema)
