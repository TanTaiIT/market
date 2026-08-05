import { Types } from 'mongoose'
import { listingRepository } from './listing.repository'
import { CreateListingInput, UpdateListingInput, ListingQuery, NearbyQuery } from './listing.schema'
import { IListing } from './listing.model'
import { NotFoundError, ForbiddenError } from '../../common/errors'
import { LISTING_STATUS } from '../../common/constants'
import { slugifyWithSuffix } from '../../common/utils/slugify'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

const LISTING_TTL_DAYS = 30

function toListingDoc(input: CreateListingInput, sellerId: string): Partial<IListing> {
  const expiresAt = new Date(Date.now() + LISTING_TTL_DAYS * 24 * 60 * 60 * 1000)
  return {
    title: input.title,
    slug: slugifyWithSuffix(input.title, Date.now().toString(36)),
    description: input.description,
    price: input.price,
    isNegotiable: input.isNegotiable ?? false,
    condition: input.condition,
    images: input.images,
    category: new Types.ObjectId(input.categoryId),
    seller: new Types.ObjectId(sellerId),
    location: { type: 'Point', ...input.location },
    attributes: input.attributes ? new Map(Object.entries(input.attributes)) : new Map(),
    status: LISTING_STATUS.PENDING,
    expiresAt,
  }
}

async function assertOwner(id: string, userId: string) {
  const listing = await listingRepository.findById(id)
  if (!listing) throw new NotFoundError('Listing not found')
  if (listing.seller._id.toString() !== userId) {
    throw new ForbiddenError('You can only modify your own listing')
  }
  return listing
}

export const listingService = {
  async create(input: CreateListingInput, sellerId: string) {
    return listingRepository.create(toListingDoc(input, sellerId))
  },

  async list(query: ListingQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await listingRepository.paginate(query, pagination)
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  async nearby(query: NearbyQuery) {
    const pagination = parsePagination(query)
    const items = await listingRepository.findNearby(
      {
        lng: query.lng,
        lat: query.lat,
        maxDistance: query.maxDistance,
        extra: { status: LISTING_STATUS.ACTIVE },
      },
      pagination,
    )
    return { items, meta: { page: pagination.page, limit: pagination.limit } }
  },

  async getByIdAndTrackView(id: string) {
    const listing = await listingRepository.incrementView(id)
    if (!listing) throw new NotFoundError('Listing not found')
    return listing
  },

  async update(id: string, userId: string, input: UpdateListingInput) {
    await assertOwner(id, userId)

    const { categoryId, location, attributes, ...rest } = input
    const update: Partial<IListing> = { ...rest }
    if (categoryId) update.category = new Types.ObjectId(categoryId)
    if (location) update.location = { type: 'Point', ...location }
    if (attributes) update.attributes = new Map(Object.entries(attributes))

    return listingRepository.updateById(id, update)
  },

  async remove(id: string, userId: string) {
    await assertOwner(id, userId)
    return listingRepository.softDelete(id)
  },
}
