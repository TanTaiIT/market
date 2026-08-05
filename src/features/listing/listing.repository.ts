import { FilterQuery, SortOrder } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { ListingQuery } from './listing.schema'
import { PaginationParams } from '../../common/utils/pagination'

/**
 * Xây filter Mongo từ query đã validate.
 */
export function buildFilter(params: Partial<ListingQuery>): FilterQuery<IListingDocument> {
  const filter: FilterQuery<IListingDocument> = {}

  if (params.status) filter.status = params.status
  if (params.category) filter.category = params.category
  if (params.seller) filter.seller = params.seller
  if (params.condition) filter.condition = params.condition
  if (params.province) filter['location.province'] = params.province

  if (params.minPrice != null || params.maxPrice != null) {
    filter.price = {}
    if (params.minPrice != null) filter.price.$gte = params.minPrice
    if (params.maxPrice != null) filter.price.$lte = params.maxPrice
  }

  if (params.q) filter.$text = { $search: params.q }

  return filter
}

export const listingRepository = {
  create(data: Partial<IListing>) {
    return Listing.create(data)
  },

  findById(id: string) {
    return Listing.findById(id)
      .populate('category', 'name slug')
      .populate('seller', 'name avatar ratingAvg')
  },

  async paginate(params: ListingQuery, { skip, limit }: PaginationParams) {
    const filter = buildFilter(params)
    const sort: Record<string, SortOrder | { $meta: string }> = params.q
      ? { score: { $meta: 'textScore' } }
      : { createdAt: -1 }
    const projection = params.q ? { score: { $meta: 'textScore' } } : {}

    const [items, total] = await Promise.all([
      Listing.find(filter, projection)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('category', 'name slug')
        .populate('seller', 'name avatar ratingAvg'),
      Listing.countDocuments(filter),
    ])

    return { items, total }
  },

  /**
   * Tìm tin gần một toạ độ (mét). $near tự sắp xếp theo khoảng cách.
   */
  findNearby(
    args: { lng: number; lat: number; maxDistance?: number; extra?: FilterQuery<IListingDocument> },
    { skip, limit }: PaginationParams,
  ) {
    const { lng, lat, maxDistance = 10000, extra = {} } = args
    return Listing.find({
      ...extra,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: maxDistance,
        },
      },
    })
      .skip(skip)
      .limit(limit)
      .populate('category', 'name slug')
  },

  updateById(id: string, update: Partial<IListing>) {
    return Listing.findByIdAndUpdate(id, update, { new: true, runValidators: true })
  },

  incrementView(id: string) {
    return Listing.findByIdAndUpdate(id, { $inc: { viewCount: 1 } }, { new: true })
  },

  softDelete(id: string) {
    return Listing.findByIdAndUpdate(id, { deletedAt: new Date() }, { new: true })
  },
}
