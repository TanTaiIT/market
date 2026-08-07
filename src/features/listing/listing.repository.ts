import { FilterQuery, Types } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { ListingQuery } from './listing.schema'
import { PaginationParams } from '../../common/utils/pagination'
import { LISTING_STATUS, PUBLIC_LISTING_STATUSES, ListingStatus } from '../../common/constants'
import { runUnscoped } from '../../common/tenant/tenantContext'

/** `status` không nằm trong query schema công khai — chỉ caller nội bộ mới được ép. */
export type ListingFilterParams = Partial<ListingQuery> & { status?: ListingStatus }

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Xây filter Mongo từ query đã validate. `organizationId` KHÔNG xuất hiện ở đây —
 * tenantPlugin chèn nó ở tầng dưới, repository cố tình không được phép tự quyết.
 */
export function buildFilter(params: ListingFilterParams): FilterQuery<IListingDocument> {
  // Mặc định ACTIVE: thiếu dòng này thì tin draft/pending/rejected/hidden lọt ra API public.
  const filter: FilterQuery<IListingDocument> = { status: params.status ?? LISTING_STATUS.ACTIVE }

  if (params.category) filter.category = params.category
  if (params.seller) filter.seller = params.seller
  if (params.condition) filter.condition = params.condition
  if (params.province) filter['location.province'] = params.province

  if (params.minPrice != null || params.maxPrice != null) {
    filter.price = {}
    if (params.minPrice != null) filter.price.$gte = params.minPrice
    if (params.maxPrice != null) filter.price.$lte = params.maxPrice
  }

  // ponytail: regex thay cho $text vì text index không sống chung được với scope nhiều org
  // (prefix của text index bắt buộc equality). Trần: quét trong phạm vi org, chấp nhận được
  // ở quy mô hiện tại — nâng cấp là Atlas Search ($search hỗ trợ filter $in nhiều org).
  if (params.q) {
    const term = new RegExp(escapeRegex(params.q), 'i')
    filter.$or = [{ title: term }, { description: term }]
  }

  return filter
}

export const listingRepository = {
  create(data: Partial<IListing>) {
    return Listing.create(data)
  },

  // Không populate gì cả. `seller`: User nằm ngoài tenantPlugin nên populate xuyên org lách
  // được cách ly — tên/liên hệ đọc từ snapshot posterName/posterContact. `category`: model
  // Category chưa tồn tại (feature còn là skeleton) nên populate nó ném MissingSchemaError.
  findById(id: string) {
    return Listing.findById(id)
  },

  async paginate(params: ListingFilterParams, { skip, limit }: PaginationParams) {
    const filter = buildFilter(params)

    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
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
  },

  updateById(id: string, update: Partial<IListing>) {
    return Listing.findByIdAndUpdate(id, update, { new: true, runValidators: true })
  },

  /**
   * Chỉ trả tin ở trạng thái public — chặn xem tin chưa duyệt qua đường /:id.
   *
   * Đọc và ghi tách làm hai bước vì chúng chạy trên hai scope khác nhau: đọc được phép
   * xuyên org trong chain, còn mọi thao tác ghi bị ép về org của chính mình. Bộ đếm view
   * của tin org khác chỉ tăng được sau khi lượt đọc đó đã được scope cho phép.
   */
  async incrementView(id: string) {
    const listing = await Listing.findOne({
      _id: id,
      status: { $in: PUBLIC_LISTING_STATUSES },
    })
    if (!listing) return null

    await runUnscoped('view counter of an already-authorized listing', () =>
      Listing.updateOne({ _id: listing._id }, { $inc: { viewCount: 1 } }).exec(),
    )
    listing.viewCount += 1
    return listing
  },

  softDelete(id: string) {
    return Listing.findByIdAndUpdate(id, { deletedAt: new Date() }, { new: true })
  },

  /** Breakdown theo org cho thống kê chain — scope đọc đã do middleware chain quyết định. */
  countByOrganizations() {
    return Listing.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { deletedAt: null } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ])
  },
}
