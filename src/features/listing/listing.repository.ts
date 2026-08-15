import { FilterQuery, Types } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { ListingQuery } from './listing.schema'
import { PaginationParams } from '../../common/utils/pagination'
import {
  LISTING_STATUS,
  MODERATABLE_STATUSES,
  PUBLIC_LISTING_STATUSES,
  ListingStatus,
} from '../../common/constants'
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
   * "Gần đây" theo địa giới hành chính thay cho `$near`: lọc trong tỉnh, rồi xếp tin CÙNG XÃ
   * lên trước. Không lọc cứng theo xã vì xã thưa tin sẽ ra màn rỗng, trong khi tin ở xã bên
   * cạnh vẫn đúng thứ người mua muốn thấy.
   */
  async findByArea(
    args: {
      province: string
      ward?: string
      exclude?: string
      extra?: FilterQuery<IListingDocument>
    },
    { skip, limit }: PaginationParams,
  ) {
    const { province, ward, exclude, extra = {} } = args
    const base: FilterQuery<IListingDocument> = { ...extra, 'location.province': province }
    if (exclude) base._id = { $ne: new Types.ObjectId(exclude) }

    if (!ward) {
      return Listing.find(base).sort({ createdAt: -1 }).skip(skip).limit(limit)
    }

    // Hai truy vấn `find` chứ không phải một `aggregate` xếp hạng: pipeline aggregate được
    // tenantPlugin chèn `organizationId` nhưng KHÔNG dính hook soft-delete của model, nên tin
    // đã xoá sẽ lọt ra. Đường này chạy qua `find`/`countDocuments` — cả hai đều đủ hook.
    const inWard = { ...base, 'location.ward': ward }
    const outWard = { ...base, 'location.ward': { $ne: ward } }

    const head = await Listing.find(inWard).sort({ createdAt: -1 }).skip(skip).limit(limit)
    if (head.length >= limit) return head

    // Tổng số tin cùng xã là mốc để cắt offset giữa hai tập, nhưng CHỈ cần khi đã sang trang:
    // ở trang đầu offset của tập sau luôn bằng 0, đếm thêm một lượt là thừa đúng ở ca hay gặp nhất.
    const wardTotal = skip > 0 ? await Listing.countDocuments(inWard) : 0

    const tail = await Listing.find(outWard)
      .sort({ createdAt: -1 })
      .skip(Math.max(0, skip - wardTotal))
      .limit(limit - head.length)

    return [...head, ...tail]
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

  /**
   * Danh sách cho bàn duyệt. KHÔNG đi qua `buildFilter`: hàm đó mặc định `status: ACTIVE` để
   * bảo vệ endpoint public, nên bỏ trống status ở đây sẽ ra "chỉ tin đang hiển thị" thay vì
   * "mọi trạng thái" — đúng ngược với thứ tab "Tất cả" của bàn duyệt cần.
   */
  /**
   * Tin của chính người đăng, MỌI trạng thái. Cố tình không đi qua `buildFilter`: hàm đó mặc
   * định `status: ACTIVE`, mà tin vừa đăng luôn là `pending` — chủ tin không thấy tin mình vừa
   * ghim thì nhìn hệt như đăng hụt.
   */
  async paginateMine(sellerId: string, { skip, limit }: PaginationParams) {
    const filter: FilterQuery<IListingDocument> = { seller: sellerId }
    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Listing.countDocuments(filter),
    ])
    return { items, total }
  },

  async paginateForModeration(
    status: ListingStatus | undefined,
    { skip, limit }: PaginationParams,
  ) {
    const filter: FilterQuery<IListingDocument> = {
      status: status ?? { $in: [...MODERATABLE_STATUSES] },
    }
    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Listing.countDocuments(filter),
    ])
    return { items, total }
  },

  /**
   * Số liệu cho màn tổng quan của bàn quản trị, gói trong ba aggregate chạy song song.
   * `tenantPlugin` chèn `$match organizationId` vào đầu mỗi pipeline nên không cần lọc tay.
   */
  async statsForModeration(trendDays: number) {
    const since = new Date(Date.now() - trendDays * 24 * 60 * 60 * 1000)

    const [byStatus, byCategory, byDay] = await Promise.all([
      Listing.aggregate<{ _id: ListingStatus; count: number }>([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Listing.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { deletedAt: null } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      Listing.aggregate<{ _id: string; approved: number; pending: number }>([
        { $match: { deletedAt: null, createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            approved: {
              $sum: { $cond: [{ $eq: ['$status', LISTING_STATUS.ACTIVE] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ['$status', LISTING_STATUS.PENDING] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ])

    return { byStatus, byCategory, byDay }
  },

  /** Breakdown theo org cho thống kê chain — scope đọc đã do middleware chain quyết định. */
  countByOrganizations() {
    return Listing.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { deletedAt: null } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ])
  },
}
