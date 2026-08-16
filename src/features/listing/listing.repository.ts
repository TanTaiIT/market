import { FilterQuery, Types } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { ListingQuery } from './listing.schema'
import { PaginationParams } from '../../common/utils/pagination'
import {
  LISTING_STATUS,
  MODERATABLE_STATUSES,
  POST_VISIBILITY,
  PUBLIC_LISTING_STATUSES,
  ListingStatus,
} from '../../common/constants'

import { runUnscoped } from '../../common/tenant/tenantContext'

/** Hai trạng thái đều là 'đang chiếm một slot của hàng đợi duyệt'. */
const PENDING_STATUSES = [LISTING_STATUS.PENDING, LISTING_STATUS.PENDING_UNVERIFIED]

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

  /** Bucket quota trục org: tin CHỜ DUYỆT của một người trong một org. */
  countPendingInOrg(sellerId: Types.ObjectId, organizationId: Types.ObjectId) {
    return Listing.countDocuments({
      seller: sellerId,
      organizationId,
      status: { $in: PENDING_STATUSES },
    }).exec()
  },

  /** Bucket quota trục danh mục — tách hẳn khỏi bucket org (§8.2). */
  countPendingInCategory(sellerId: Types.ObjectId, categoryId: Types.ObjectId) {
    return Listing.countDocuments({
      seller: sellerId,
      category: categoryId,
      visibility: POST_VISIBILITY.PUBLIC,
      status: { $in: PENDING_STATUSES },
    }).exec()
  },

  /**
   * Tin bị từ chối gần đây, ĐẾM XUYÊN TRỤC. Cố tình không lọc org/visibility: bị từ chối ở
   * đâu cũng là tín hiệu về người đăng, và đếm theo từng trục là để hở đúng đường vòng.
   */
  countRecentRejections(sellerId: Types.ObjectId, since: Date) {
    return Listing.countDocuments({
      seller: sellerId,
      status: LISTING_STATUS.REJECTED,
      'moderation.at': { $gte: since },
    }).exec()
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
   * Đọc và ghi tách làm hai bước: bộ đếm view phải tăng được cả khi lượt đọc đến từ một
   * scope rộng hơn scope ghi (tin trục công khai). Chạy unscoped nhưng chỉ sau khi
   * lượt đọc đã được scope cho phép.
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
   * Tin của chính người đăng, MỌI trạng thái. Cố tình không đi qua `buildFilter`: hàm đó mặc
   * định `status: ACTIVE`, mà tin vừa đăng luôn là `pending` — chủ tin không thấy tin mình vừa
   * ghim thì nhìn hệt như đăng hụt.
   */
  async paginateMine(sellerId: string, { skip, limit }: PaginationParams) {
    const filter: FilterQuery<IListingDocument> = { seller: sellerId }

    // Scope theo NGƯỜI ĐĂNG, không theo trục: `sellerId` lấy từ token nên nó đã hẹp hơn mọi
    // scope tenant. Để plugin áp trục vào đây thì tin công khai đang chờ duyệt của một người
    // không thuộc org nào sẽ biến mất khỏi màn "tin của tôi" — đúng cái "đăng hụt" mà chính
    // hàm này sinh ra để tránh.
    return runUnscoped('own listings, scoped by seller', async () => {
      const [items, total] = await Promise.all([
        Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
        Listing.countDocuments(filter).exec(),
      ])
      return { items, total }
    })
  },

  /**
   * Hàng đợi trục công khai. Phạm vi (danh mục × tỉnh) KHÔNG nằm ở đây — nó do scope quyết
   * định và `tenantPlugin` áp; repository chỉ chọn trạng thái.
   */
  async paginateForPublicModeration(
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

  /** Tồn đọng theo từng ô (danh mục × tỉnh) — đầu vào của dashboard phủ sóng. */
  pendingByCategoryProvince() {
    return Listing.aggregate<{
      _id: { category: Types.ObjectId; province: string }
      count: number
    }>([
      { $match: { status: { $in: PENDING_STATUSES }, visibility: POST_VISIBILITY.PUBLIC } },
      { $group: { _id: { category: '$category', province: '$provinceCode' }, count: { $sum: 1 } } },
    ])
  },

  /**
   * Danh sách cho bàn duyệt của org. KHÔNG đi qua `buildFilter`: hàm đó mặc định
   * `status: ACTIVE` để bảo vệ endpoint public, nên bỏ trống status ở đây sẽ ra "chỉ tin đang
   * hiển thị" thay vì "mọi trạng thái" — đúng ngược với thứ tab "Tất cả" của bàn duyệt cần.
   */
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
}
