import { FilterQuery, Types } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { AttrQuery, ListingQuery } from './listing.schema'
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

/** Một ràng buộc `attrs` → vế `v` của `$elemMatch`. Xem `attrConstraintSchema` cho ba dạng. */
function matchValue(constraint: AttrQuery): Record<string, unknown> {
  if (Array.isArray(constraint)) return { v: { $in: constraint } }
  if (typeof constraint === 'object') {
    const range: Record<string, number> = {}
    if (constraint.gte !== undefined) range.$gte = constraint.gte
    if (constraint.lte !== undefined) range.$lte = constraint.lte
    return { v: range }
  }
  return { v: constraint }
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

  /*
   * Lọc thuộc tính động qua bản phẳng `attrs`, KHÔNG qua `attributes`.
   *
   * `attributes` là Map với key động — Mongo không index được key động, nên lọc trên nó là quét
   * toàn bộ. `attrs` là mảng cặp `{k, v}` nên một index duy nhất phục vụ được mọi field.
   *
   * Mỗi ràng buộc là một `$elemMatch` RIÊNG, gộp bằng `$and`. Nhét chung một `$elemMatch` sẽ
   * thành "có MỘT phần tử vừa k=brand vừa k=fuelType" — không phần tử nào thoả, kết quả luôn rỗng.
   */
  const constraints = Object.entries(params.attrs ?? {})
  if (constraints.length > 0) {
    filter.$and = constraints.map(([k, v]) => ({
      attrs: { $elemMatch: { k, ...matchValue(v) } },
    }))
  }
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
  /*
   * BA phép đếm dưới đây đều chạy `runUnscoped`, và đó là điều kiện để chúng ĐÚNG.
   *
   * Chúng đếm tin ở trạng thái `pending` / `rejected`, trong khi vế trục công khai mà
   * `tenantPlugin` chèn vào mọi `countDocuments` là `{visibility: public, status ∈
   * [active, sold, expired]}`. Hai điều kiện status loại trừ nhau, nên với người dùng KHÔNG
   * thuộc org nào (scope chỉ có trục công khai) mọi phép đếm đều ra 0 — hạn mức tin chờ và
   * chốt phanh-sau-khi-bị-từ-chối im lặng ngừng hoạt động, đúng với nhóm đông nhất của sàn.
   *
   * Đây là phép đếm NỘI BỘ để chặn spam, không phải đường đọc dữ liệu cho người dùng: kết
   * quả chỉ ra một con số, không rò một dòng tin nào. Vì thế bỏ scope là hợp lệ và bắt buộc.
   */
  countPendingInOrg(sellerId: Types.ObjectId, organizationId: Types.ObjectId) {
    return runUnscoped('quota: đếm tin chờ duyệt của người này trong org đích', () =>
      Listing.countDocuments({
        seller: sellerId,
        organizationId,
        status: { $in: PENDING_STATUSES },
      }).exec(),
    )
  },

  /** Bucket quota trục danh mục — tách hẳn khỏi bucket org (§8.2). */
  countPendingInCategory(sellerId: Types.ObjectId, categoryId: Types.ObjectId) {
    return runUnscoped('quota: đếm tin chờ duyệt của người này trong danh mục', () =>
      Listing.countDocuments({
        seller: sellerId,
        category: categoryId,
        visibility: POST_VISIBILITY.PUBLIC,
        status: { $in: PENDING_STATUSES },
      }).exec(),
    )
  },

  /**
   * Mốc bị từ chối GẦN NHẤT trong cửa sổ — để nói với người bán "tự đăng lại được sau N
   * ngày" thay vì để họ đoán. Cùng lý do unscoped với `countRecentRejections` ngay dưới.
   */
  async lastRejectionAt(sellerId: Types.ObjectId, since: Date): Promise<Date | null> {
    const row = await runUnscoped('quota: mốc bị từ chối gần nhất của người bán', () =>
      Listing.findOne({
        seller: sellerId,
        status: LISTING_STATUS.REJECTED,
        'moderation.at': { $gte: since },
        'moderation.severity': { $ne: 'quality' },
      })
        .sort({ 'moderation.at': -1 })
        .select('moderation.at')
        .lean()
        .exec(),
    )
    return row?.moderation?.at ?? null
  },

  /**
   * Master gỡ án: hạ mức mọi lượt TỪ CHỐI VI PHẠM gần đây của người này về `quality`.
   *
   * Dùng lại chính cơ chế mức độ thay vì thêm một field "đã ân xá": `countRecentRejections`
   * vốn đã bỏ qua `quality`, nên chỉ cần hạ mức là án tự hết — một luật, không phải hai.
   *
   * KHÔNG xoá gì: `reason` và `moderation.at` ở lại nguyên, và vết master đã gỡ án nằm ở
   * nhật ký kiểm toán. Thứ duy nhất đổi là PHÂN LOẠI mức độ — đúng thứ master đang ghi đè.
   */
  async downgradeRecentRejections(sellerId: Types.ObjectId, since: Date): Promise<number> {
    const res = await runUnscoped('master gỡ án phạt: hạ mức vi phạm gần đây', () =>
      Listing.updateMany(
        {
          seller: sellerId,
          status: LISTING_STATUS.REJECTED,
          'moderation.at': { $gte: since },
          'moderation.severity': { $ne: 'quality' },
        },
        { $set: { 'moderation.severity': 'quality' } },
      ).exec(),
    )
    return res.modifiedCount
  },

  /**
   * Tin bị từ chối gần đây, ĐẾM XUYÊN TRỤC. Cố tình không lọc org/visibility: bị từ chối ở
   * đâu cũng là tín hiệu về người đăng, và đếm theo từng trục là để hở đúng đường vòng.
   */
  countRecentRejections(sellerId: Types.ObjectId, since: Date) {
    return runUnscoped('quota: đếm lượt bị từ chối gần đây, xuyên mọi trục', () =>
      Listing.countDocuments({
        seller: sellerId,
        status: LISTING_STATUS.REJECTED,
        'moderation.at': { $gte: since },
        // `$ne` chứ không `$eq: violation`: tin bị từ chối TRƯỚC ngày phân mức không có
        // field này, và ân xá ngược cho chúng là tự xoá lịch sử vi phạm.
        'moderation.severity': { $ne: 'quality' },
      }).exec(),
    )
  },

  // Không populate gì cả. `seller`: User nằm ngoài tenantPlugin nên populate xuyên org lách
  // được cách ly — tên/liên hệ đọc từ snapshot posterName/posterContact. `category`: model
  // Category chưa tồn tại (feature còn là skeleton) nên populate nó ném MissingSchemaError.
  findById(id: string) {
    return Listing.findById(id)
  },

  /**
   * Đọc nhiều tin cùng lúc (danh sách tin đã lưu). KHÔNG sắp xếp: `$in` của Mongo trả về theo
   * thứ tự tự nhiên của collection, nên thứ tự phải do caller dựng lại từ chính mảng id.
   *
   * Tin đã xoá hoặc ngoài scope đọc rơi khỏi kết quả — caller phải chịu được mảng ngắn hơn
   * mảng id truyền vào, và đó là hành vi ĐÚNG: tin đã gỡ không hiện lại chỉ vì ai đó từng lưu.
   */
  findByIds(ids: Types.ObjectId[]) {
    return Listing.find({ _id: { $in: ids } })
  },

  async paginate(params: ListingFilterParams, { skip, limit }: PaginationParams) {
    const filter = buildFilter(params)

    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ rankAt: -1 }).skip(skip).limit(limit),
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
      return Listing.find(base).sort({ rankAt: -1 }).skip(skip).limit(limit)
    }

    // Hai truy vấn `find` chứ không phải một `aggregate` xếp hạng: pipeline aggregate được
    // tenantPlugin chèn `organizationId` nhưng KHÔNG dính hook soft-delete của model, nên tin
    // đã xoá sẽ lọt ra. Đường này chạy qua `find`/`countDocuments` — cả hai đều đủ hook.
    const inWard = { ...base, 'location.ward': ward }
    const outWard = { ...base, 'location.ward': { $ne: ward } }

    const head = await Listing.find(inWard).sort({ rankAt: -1 }).skip(skip).limit(limit)
    if (head.length >= limit) return head

    // Tổng số tin cùng xã là mốc để cắt offset giữa hai tập, nhưng CHỈ cần khi đã sang trang:
    // ở trang đầu offset của tập sau luôn bằng 0, đếm thêm một lượt là thừa đúng ở ca hay gặp nhất.
    const wardTotal = skip > 0 ? await Listing.countDocuments(inWard) : 0

    const tail = await Listing.find(outWard)
      .sort({ rankAt: -1 })
      .skip(Math.max(0, skip - wardTotal))
      .limit(limit - head.length)

    return [...head, ...tail]
  },

  /**
   * Hạ MỌI tin quá hạn xuống `expired`, trả về số tin đã đổi.
   *
   * `updateMany` một lượt chứ không batch: điều kiện đi trọn index `{ status, expiresAt }` và
   * mỗi tin chỉ bị đụng đúng một lần trong đời (sau lượt này nó không còn `active`), nên
   * không có nguy cơ quét lại tăng dần như hàng đợi duyệt máy.
   *
   * Người gọi phải bọc `runUnscoped` — xem `listingExpiryService.sweep`.
   */
  async expireDue(now: Date): Promise<number> {
    const res = await Listing.updateMany(
      { status: LISTING_STATUS.ACTIVE, expiresAt: { $lte: now } },
      { $set: { status: LISTING_STATUS.EXPIRED } },
    ).exec()
    return res.modifiedCount
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

  /**
   * Bộ đếm lượt lưu. `runUnscoped` vì đúng lý do của `incrementView`: lượt ghi này đến từ
   * NGƯỜI ĐỌC tin, mà scope ghi của họ hẹp hơn scope đọc (tin trục công khai của org khác).
   * Chỉ gọi sau khi thao tác đã được scope cho phép.
   *
   * Điều kiện `favoriteCount > 0` nằm trong filter chứ không kiểm ở service: hai lượt bỏ tim
   * chạy song song sẽ cùng đọc ra 1 rồi cùng trừ, đẩy bộ đếm xuống âm — chỉ Mongo mới chốt
   * được điều kiện đó cùng lúc với phép trừ.
   */
  adjustFavoriteCount(id: Types.ObjectId, delta: number) {
    const filter = delta < 0 ? { _id: id, favoriteCount: { $gt: 0 } } : { _id: id }
    return runUnscoped('favorite counter of an already-authorized listing', () =>
      Listing.updateOne(filter, { $inc: { favoriteCount: delta } }).exec(),
    )
  },

  /**
   * Ẩn mọi tin còn "sống" của một người — bước dọn dẹp khi tài khoản bị khoá.
   *
   * `runUnscoped` vì tin của một người rải trên nhiều org lẫn trục công khai, còn master thao
   * tác thì không đứng trong org nào — scope của request không phủ nổi tập cần ẩn.
   *
   * Ẩn cả tin CHỜ DUYỆT chứ không riêng tin đang hiển thị: để chúng lại là hàng đợi của người
   * duyệt vẫn đầy rác của một tài khoản đã khoá.
   */
  hideAllBySeller(sellerId: Types.ObjectId, moderation: IListing['moderation']) {
    return runUnscoped('lock account: hide every live listing of the locked user', () =>
      Listing.updateMany(
        {
          seller: sellerId,
          status: {
            $in: [LISTING_STATUS.ACTIVE, LISTING_STATUS.PENDING, LISTING_STATUS.PENDING_UNVERIFIED],
          },
        },
        { status: LISTING_STATUS.HIDDEN, moderation },
      ).exec(),
    )
  },

  // ── MACHINE REVIEW (job) ────────────────────────────────────────────────────
  // Cả cụm chạy ngoài request nên tự khai `runUnscoped` tại đây — mỗi đường một lý do grep được.
  // Chỉ nhận `PENDING`: `PENDING_UNVERIFIED` là tin người ngoài, máy không có quyền đụng
  // (routing đã chốt "người ngoài không bao giờ tự đăng", máy duyệt hộ là lách đúng chốt đó).

  findMachineQueue(limit: number) {
    return runUnscoped('machine review: đọc hàng đợi pending chưa chấm', () =>
      Listing.find({ status: LISTING_STATUS.PENDING, machineReview: null })
        .sort({ createdAt: 1 })
        .limit(limit)
        .exec(),
    )
  },

  /** Mẫu giá tin ACTIVE mới nhất của danh mục — xuyên trục, vì giá phổ biến không phân biệt org. */
  async sampleActivePrices(categoryId: Types.ObjectId, limit: number): Promise<number[]> {
    const rows = await runUnscoped('machine review: lấy mẫu giá của danh mục', () =>
      Listing.find({ category: categoryId, status: LISTING_STATUS.ACTIVE })
        .select('price')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec(),
    )
    return rows.map((r) => r.price)
  },

  /**
   * Cùng người bán, tiêu đề y hệt (không phân hoa/thường), còn sống, trong cửa sổ gần đây.
   * `excludeId` null = tin đang XÉT chưa được ghi (cổng nội dung lúc create) — không có gì để loại.
   */
  async hasRecentDuplicateTitle(
    sellerId: Types.ObjectId,
    title: string,
    excludeId: Types.ObjectId | null,
    since: Date,
  ): Promise<boolean> {
    const dup = await runUnscoped('machine review: soi tin trùng của cùng người bán', () =>
      Listing.exists({
        seller: sellerId,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        title: new RegExp(`^${escapeRegex(title)}$`, 'i'),
        status: { $in: [LISTING_STATUS.ACTIVE, ...PENDING_STATUSES] },
        createdAt: { $gte: since },
      }).exec(),
    )
    return dup !== null
  },

  /**
   * Số tin nhóm đăng kể từ mốc `since` — nhịp sống hiện trên hồ sơ nhóm công khai.
   *
   * ⚠️ `runUnscoped` MỚI trong luồng request (convention §6.4 xếp vào diện phải hỏi trước).
   * Lý do phải mở: hồ sơ nhóm là route CÔNG KHAI nên scope của request là `publicOnly`, mà
   * `Listing` có `tenantPlugin` — đếm dưới scope đó chỉ ra tin công khai đã duyệt, tức con số
   * luôn sai và luôn nhỏ hơn sự thật.
   *
   * Thu hẹp hết mức để đánh đổi này chỉ đúng một dòng: khoá cứng vào MỘT `organizationId` mà
   * người gọi đã nêu tên, và trả về một CON SỐ chứ không phải bản ghi nào. Không có đường nào
   * từ đây đọc ra nội dung tin của org khác.
   *
   * Người gọi phải tự chắc org đó `isPublic` — `organizationService.publicProfile` là call site
   * duy nhất, và nó lấy org qua `findPublicBySlug`.
   */
  countCreatedSinceForOrg(organizationId: Types.ObjectId, since: Date): Promise<number> {
    return runUnscoped('đếm nhịp đăng tin của MỘT nhóm công khai cho hồ sơ công khai', () =>
      Listing.countDocuments({ organizationId, createdAt: { $gte: since } }).exec(),
    )
  },

  /**
   * Ghi phán quyết máy, có chốt race: điều kiện `status: PENDING` làm người duyệt tay thắng —
   * họ bấm trước thì lệnh này match 0 document và trả `null`, máy lặng lẽ bỏ qua. Không cần
   * lock hay lease, và cũng vì thế chạy 2 instance không xử trùng.
   */
  applyMachineVerdict(id: Types.ObjectId, update: Partial<IListing>) {
    return runUnscoped('machine review: ghi phán quyết vào tin còn pending', () =>
      Listing.findOneAndUpdate({ _id: id, status: LISTING_STATUS.PENDING }, update, {
        new: true,
        runValidators: true,
      }).exec(),
    )
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
   * Tin của MỘT người bán cần đối soát: đã hết hạn, hoặc sắp hết hạn trước `cutoff`.
   *
   * `runUnscoped` + lọc theo `seller` cùng lý do `paginateMine`: khoá đã hẹp hơn mọi scope
   * tenant, mà áp thêm trục sẽ làm tin công khai của người không thuộc org nào biến mất — đúng
   * nhóm tin mà màn đối soát cần đem ra hỏi nhất.
   *
   * `limit` cứng: đây là dữ liệu cho một màn hỏi-đáp, không phải một bảng có phân trang. Người
   * có 300 tin quá hạn thì hỏi 20 tin cũ nhất trước cũng đủ việc cho một lượt.
   */
  findNeedingReconcile(sellerId: string, cutoff: Date, limit: number) {
    return runUnscoped('reconcile: tin quá hạn/sắp hết hạn của chính chủ', () =>
      Listing.find({
        seller: sellerId,
        status: { $in: [LISTING_STATUS.ACTIVE, LISTING_STATUS.EXPIRED] },
        expiresAt: { $lte: cutoff },
      })
        .sort({ expiresAt: 1 })
        .limit(limit)
        .exec(),
    )
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
  /**
   * Đo lượng đăng tin toàn nền tảng — dữ liệu ĐỊNH GIÁ cho hệ Xu (xu-wallet.decision.md §3).
   * Số này phải tích luỹ TRƯỚC ngày bật phí, nên endpoint tồn tại từ giai đoạn miễn phí.
   *
   * Đếm MỌI tin được tạo trong cửa sổ, kể cả bị từ chối hay đã xoá sau đó: thứ cần đo là
   * NHU CẦU đăng (thứ sẽ bị tính phí), không phải số tin sống sót.
   *
   * Không có index cho `createdAt` trần và không thêm: đường lạnh master-only chạy vài lần
   * mỗi tháng — một COLLSCAN đo được còn rẻ hơn một index phải nuôi trên mọi lượt ghi
   * (đúng tinh thần rule 13: nghi ngờ thì ĐO, đừng thêm bừa).
   */
  async postingStats(since: Date) {
    const [facets] = await runUnscoped('pricing prep: đo lượng đăng tin toàn nền tảng', () =>
      Listing.aggregate<{
        total: Array<{ count: number }>
        posters: Array<{ count: number }>
        byCategory: Array<{ _id: Types.ObjectId; count: number }>
        posterHistogram: Array<{ _id: number | string; users: number }>
      }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $facet: {
            total: [{ $count: 'count' }],
            posters: [{ $group: { _id: '$seller' } }, { $count: 'count' }],
            byCategory: [
              { $group: { _id: '$category', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 20 },
            ],
            // Ai đăng bao nhiêu — nhóm 4+ tin/cửa sổ chính là nhóm sẽ trả tiền.
            posterHistogram: [
              { $group: { _id: '$seller', posts: { $sum: 1 } } },
              {
                $bucket: {
                  groupBy: '$posts',
                  boundaries: [1, 2, 4, 11],
                  default: '11+',
                  output: { users: { $sum: 1 } },
                },
              },
            ],
          },
        },
      ]).exec(),
    )

    return {
      totalPosts: facets.total[0]?.count ?? 0,
      distinctPosters: facets.posters[0]?.count ?? 0,
      byCategory: facets.byCategory,
      posterHistogram: facets.posterHistogram,
    }
  },
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

  /**
   * Mọi URL ảnh mà tin còn giữ — cho job dọn ảnh mồ côi (`upload.cleanup.service.ts`).
   * Gồm cả snapshot avatar người đăng. Tin xoá mềm cố ý RỚT khỏi kết quả (hook của model):
   * không có đường khôi phục tin, nên ảnh của nó là rác hợp lệ.
   */
  // ── IMAGE MODERATION (webhook Cloudinary) ──────────────────────────────────
  // Cùng lý do `runUnscoped` với cụm machine review: sự kiện đến từ Cloudinary, không có
  // request người dùng nào phía sau, và ảnh bị từ chối phải được gỡ ở MỌI trục.

  /** Mọi tin (kể cả pending/hidden) còn giữ URL khớp ảnh bị từ chối. */
  findByImageRef(pattern: RegExp) {
    return runUnscoped('image moderation: tìm tin đang giữ ảnh bị từ chối', () =>
      Listing.find({ images: pattern }).exec(),
    )
  },

  /**
   * Rút ảnh bị từ chối khỏi một tin, kèm (tuỳ chọn) đổi trạng thái trong CÙNG một lệnh.
   * `ifStatus` là chốt race như `applyMachineVerdict`: người duyệt tay đổi trạng thái trước
   * thì lệnh có điều kiện match 0 document và trả `null` — caller rơi về nhánh chỉ-rút-ảnh.
   */
  scrubImageRef(
    id: Types.ObjectId,
    pattern: RegExp,
    opts: { ifStatus?: ListingStatus; set?: Partial<IListing> } = {},
  ) {
    return runUnscoped('image moderation: rút ảnh bị từ chối khỏi tin', () =>
      Listing.findOneAndUpdate(
        { _id: id, ...(opts.ifStatus ? { status: opts.ifStatus } : {}) },
        { $pull: { images: pattern }, ...(opts.set ? { $set: opts.set } : {}) },
        { new: true },
      ).exec(),
    )
  },

  /** Xoá snapshot avatar người đăng khi chính ảnh avatar đó bị từ chối — FE rơi về chữ viết tắt. */
  async clearPosterAvatarRef(pattern: RegExp): Promise<number> {
    const res = await runUnscoped('image moderation: xoá snapshot avatar bị từ chối', () =>
      Listing.updateMany({ posterAvatar: pattern }, { posterAvatar: '' }).exec(),
    )
    return res.modifiedCount
  },

  async allImageRefs(): Promise<string[]> {
    const rows = await runUnscoped('image cleanup: gom URL ảnh của mọi tin', () =>
      Listing.find().select('images posterAvatar').lean().exec(),
    )
    return rows.flatMap((r) => [...r.images, r.posterAvatar])
  },
}
