import { FilterQuery, Types } from 'mongoose'
import { Listing, IListing, IListingDocument } from './listing.model'
import { AttrQuery, ListingQuery } from './listing.schema'
import { PaginationParams } from '../../common/utils/pagination'
import {
  LISTING_STATUS,
  MODERATABLE_STATUSES,
  LISTING_REACH,
  PUBLIC_LISTING_STATUSES,
  REPORT_TIMEZONE,
  ListingStatus,
} from '../../common/constants'

import { runUnscoped } from '../../common/tenant/tenantContext'

/** Hai trạng thái đều là 'đang chiếm một slot của hàng đợi duyệt'. */
const PENDING_STATUSES = [LISTING_STATUS.PENDING, LISTING_STATUS.PENDING_UNVERIFIED]

/** `status` không nằm trong query schema công khai — chỉ caller nội bộ mới được ép. */
export type ListingFilterParams = Partial<ListingQuery> & { status?: ListingStatus }

/** Bộ lọc của bàn duyệt — khác `ListingFilterParams` ở chỗ KHÔNG có mặc định `status: ACTIVE`. */
export interface ModerationFilter {
  status?: ListingStatus
  category?: string
  q?: string
}

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
 * Xây filter Mongo từ query đã validate.
 *
 * `organizationId` ở đây CHỈ đến từ `?orgId=` của người gọi và chỉ có tác dụng THU HẸP —
 * quyền đọc vẫn do `tenantPlugin` `$and` lên trên ở tầng dưới, repository không tự quyết được
 * mình đọc org nào. Xin một nhóm mình không đọc được thì ra rỗng, không ra dữ liệu.
 */
export function buildFilter(params: ListingFilterParams): FilterQuery<IListingDocument> {
  // Mặc định ACTIVE: thiếu dòng này thì tin draft/pending/rejected/hidden lọt ra API public.
  const filter: FilterQuery<IListingDocument> = { status: params.status ?? LISTING_STATUS.ACTIVE }

  if (params.category) filter.category = params.category
  if (params.seller) filter.seller = params.seller
  // Chỉ THU HẸP. `tenantPlugin` vẫn `$and` scope đọc lên trên, nên xin bậc `members` của một
  // nhóm mình không đọc được thì ra rỗng, không ra dữ liệu.
  if (params.reach?.length === 1) filter.reach = params.reach[0]
  else if (params.reach?.length) filter.reach = { $in: params.reach }
  if (params.orgId) filter.organizationId = new Types.ObjectId(params.orgId)

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
  // Residual filter có chủ ý — xem ghi chú index ở `listing.model.ts`: xã không nằm trong index
  // để `?province=` giữ được sort index-backed. Schema đã chốt xã luôn đi kèm tỉnh.
  if (params.ward) filter['location.ward'] = params.ward

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
        reach: LISTING_REACH.MARKETPLACE,
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
    // Cùng luật với `getForViewer`: tin đã ẩn/từ chối/đang chờ không hiện trong "Tin đã lưu".
    // Nhánh org của scope không kẹp `status` (bàn duyệt cần thấy đủ), nên thành viên gửi
    // `X-Org-Id` từng thấy cả tin `hidden` của nhóm — kèm lý do ẩn — chỉ vì đã từng bấm tim.
    return Listing.find({ _id: { $in: ids }, status: { $in: PUBLIC_LISTING_STATUSES } })
  },

  async paginate(params: ListingFilterParams, { skip, limit }: PaginationParams) {
    const filter = buildFilter(params)

    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ rankAt: -1, _id: -1 }).skip(skip).limit(limit),
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
      return Listing.find(base).sort({ rankAt: -1, _id: -1 }).skip(skip).limit(limit)
    }

    // Hai truy vấn `find` chứ không phải một `aggregate` xếp hạng: pipeline aggregate được
    // tenantPlugin chèn `organizationId` nhưng KHÔNG dính hook soft-delete của model, nên tin
    // đã xoá sẽ lọt ra. Đường này chạy qua `find`/`countDocuments` — cả hai đều đủ hook.
    const inWard = { ...base, 'location.ward': ward }
    const outWard = { ...base, 'location.ward': { $ne: ward } }

    const head = await Listing.find(inWard).sort({ rankAt: -1, _id: -1 }).skip(skip).limit(limit)
    if (head.length >= limit) return head

    // Tổng số tin cùng xã là mốc để cắt offset giữa hai tập, nhưng CHỈ cần khi đã sang trang:
    // ở trang đầu offset của tập sau luôn bằng 0, đếm thêm một lượt là thừa đúng ở ca hay gặp nhất.
    const wardTotal = skip > 0 ? await Listing.countDocuments(inWard) : 0

    const tail = await Listing.find(outWard)
      .sort({ rankAt: -1, _id: -1 })
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
   * Ghi có CHỐT trạng thái — compare-and-set cho bàn duyệt. Người bấm sau khi tin đã đổi tay
   * (một moderator khác vừa xử, máy vừa duyệt) khớp 0 document và nhận `null`, thay vì đè lên
   * phán quyết vừa ghi. Cùng cơ chế với `applyMachineVerdict` nhưng cho người thật.
   */
  updateByIdIfStatus(id: string, expected: ListingStatus, update: Partial<IListing>) {
    return Listing.findOneAndUpdate({ _id: id, status: expected }, update, {
      new: true,
      runValidators: true,
    })
  },

  /** Đọc KỂ CẢ tin đã xoá mềm — cho báo cáo về một tin không còn: vẫn phải xét được trục để đóng. */
  findByIdWithDeleted(id: string) {
    return Listing.findById(id).setOptions({ withDeleted: true })
  },

  /**
   * Cộng một lượt xem. CHỈ ghi — không đọc, không xét quyền.
   *
   * Người gác là `listingService.getForViewer`, chạy TRƯỚC hàm này: nó quyết ai được xem tin
   * theo quan hệ (thành viên nhóm, người duyệt) chứ không theo tenant scope của request. Vì thế
   * đây phải là `runUnscoped`: lượt ghi đến từ NGƯỜI ĐỌC, mà scope ghi của họ hẹp hơn hẳn tập
   * tin họ được đọc (tin nội bộ của nhóm khác nhóm đang thao tác, tin trục công khai của org
   * khác). Bản cũ `incrementView` vừa đọc theo scope vừa ghi — chính lượt đọc theo scope ấy là
   * lý do thành viên mở tin nội bộ của nhóm mình nhận 404 khi `X-Org-Id` trỏ nhóm khác.
   */
  bumpView(id: Types.ObjectId) {
    return runUnscoped('view counter of an already-authorized listing', () =>
      Listing.updateOne({ _id: id }, { $inc: { viewCount: 1 } }).exec(),
    )
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
  /** `_id` mọi tin còn sống của một người — để đóng báo cáo về chúng trước khi ẩn hàng loạt. */
  liveIdsBySeller(sellerId: Types.ObjectId): Promise<Types.ObjectId[]> {
    return runUnscoped('lock account: liệt kê tin còn sống để đóng báo cáo', () =>
      Listing.find({
        seller: sellerId,
        status: {
          $in: [LISTING_STATUS.ACTIVE, LISTING_STATUS.PENDING, LISTING_STATUS.PENDING_UNVERIFIED],
        },
      })
        .select('_id')
        .lean()
        .exec()
        .then((rows) => rows.map((r) => r._id)),
    )
  },

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
        .sort({ createdAt: -1, _id: -1 })
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
   * Người gọi phải tự chắc ai được xem — `organizationService.publicProfile` là call site duy
   * nhất, và nó chặn nhóm riêng tư với người ngoài trước khi trả con số này ra.
   */
  /**
   * Hạ mọi tin `group_open` của một nhóm về `members` — gọi khi nhóm chuyển sang RIÊNG TƯ.
   *
   * `runUnscoped` là BẮT BUỘC, không phải cho tiện. `setVisibility` là thao tác của master, mà
   * master có `ownOrgId: null`; nhánh GHI của `tenantPlugin` là
   * `$or: [{organizationId: null}, {organizationId: ownOrgId}]`, nên một `updateMany` có scope
   * sẽ khớp ĐÚNG 0 dòng, trả `modifiedCount: 0` và cascade lặng lẽ không xảy ra. Không lỗi,
   * không log, chỉ là tin công khai nằm lại dưới một nhóm đã kín.
   *
   * Idempotent theo cấu tạo: bộ lọc chính là thứ nó xoá đi.
   */
  demoteGroupOpen(organizationId: Types.ObjectId): Promise<number> {
    return runUnscoped('nhóm chuyển riêng tư: hạ tin group_open về members', async () => {
      const res = await Listing.updateMany(
        { organizationId, reach: LISTING_REACH.GROUP_OPEN },
        { $set: { reach: LISTING_REACH.MEMBERS } },
      ).exec()
      return res.modifiedCount
    })
  },

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
        Listing.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).exec(),
        Listing.countDocuments(filter).exec(),
      ])
      return { items, total }
    })
  },

  /**
   * Khu vực các tin gần đây của một người — nguyên liệu cho `inferProvince`.
   *
   * MỌI trạng thái, kể cả `sold`/`expired`/`rejected`: câu hỏi ở đây là "người này ở đâu", mà
   * một tin đã bán vẫn trả lời đúng câu đó. Lọc theo `status: active` sẽ làm người vừa bán hết
   * hàng mất luôn khu vực.
   *
   * `.lean()` và chỉ lấy hai field: đây là đường chạy trên mỗi lượt `GET /users/me` của người
   * chưa khai khu vực, nên nạp cả document về để đọc một chuỗi là lãng phí đúng chỗ đông nhất.
   *
   * `runUnscoped` + lọc `seller` cùng lý do `paginateMine`: khoá đã hẹp hơn mọi scope tenant,
   * mà áp thêm trục sẽ bỏ sót chính những tin công khai của người không thuộc org nào — nhóm
   * người cần suy khu vực nhất.
   */
  recentSellerProvinces(sellerId: string, limit: number) {
    return runUnscoped('area hint: tin của chính chủ, scoped by seller', () =>
      Listing.find({ seller: sellerId, 'location.province': { $exists: true, $ne: null } })
        .select('location.province createdAt')
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean<{ location?: { province?: string }; createdAt: Date }[]>()
        .exec(),
    )
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
      Listing.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
      Listing.countDocuments(filter),
    ])
    return { items, total }
  },

  /**
   * Chuỗi thời gian của tin đăng, gộp theo NGÀY/THÁNG/NĂM trong múi giờ thị trường.
   *
   * `runUnscoped` là bắt buộc và hợp lệ: bản toàn hệ thống (master, không kèm org) phải đếm
   * CẢ HAI TRỤC — scope của request đó chỉ mở trục công khai, để plugin lọc là im lặng bỏ sót
   * toàn bộ tin nội bộ của mọi nhóm. Kết quả trả ra là CON SỐ GỘP, không có dòng tin nào lọt.
   *
   * `organizationId`: bản CỦA MỘT NHÓM cho quản trị nhóm — mọi tin MANG DẤU org đó, nội bộ lẫn
   * công khai do thành viên đăng trong ngữ cảnh nhóm (khoá trục là `visibility`, không phải
   * `organizationId`). Lọc tường minh ở đây chứ không nhờ scope: scope của quản trị nhóm là "org
   * của tôi HOẶC trục công khai", để plugin lọc thì báo cáo của nhóm 30 người đếm luôn cả bảng
   * tin công khai của cả nước.
   *
   * `deletedAt: null` khai tay vì `aggregate` không đi qua hook `pre(/^find/)` của
   * soft-delete — thiếu nó thì tin đã xoá vẫn nằm trong báo cáo.
   *
   * `$addToSet` để đếm người bán KHÁC NHAU trong mỗi cột: `$sum: 1` đếm lượt đăng, mà
   * "20 tin từ 1 người" khác hẳn "20 tin từ 20 người" — đó là hai kết luận kinh doanh trái
   * ngược nhau từ cùng một con số tổng.
   */
  reportSeries(from: Date, to: Date, format: string, organizationId: Types.ObjectId | null = null) {
    return runUnscoped('report: số liệu đăng tin — toàn hệ thống (master) hoặc một org', () =>
      Listing.aggregate<{
        _id: string
        posts: number
        sellers: string[]
        active: number
        pending: number
        rejected: number
      }>([
        {
          $match: {
            deletedAt: null,
            createdAt: { $gte: from, $lte: to },
            ...(organizationId ? { organizationId } : {}),
          },
        },
        {
          $group: {
            _id: { $dateToString: { format, date: '$createdAt', timezone: REPORT_TIMEZONE } },
            posts: { $sum: 1 },
            sellers: { $addToSet: '$seller' },
            // Trạng thái HIỆN TẠI của tin đăng trong cột đó, không phải trạng thái lúc đăng:
            // báo cáo trả lời "tin đăng ngày ấy giờ ra sao", thứ duy nhất dữ liệu này biết.
            active: { $sum: { $cond: [{ $eq: ['$status', LISTING_STATUS.ACTIVE] }, 1, 0] } },
            pending: {
              $sum: { $cond: [{ $in: ['$status', PENDING_STATUSES] }, 1, 0] },
            },
            rejected: {
              $sum: { $cond: [{ $eq: ['$status', LISTING_STATUS.REJECTED] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
    )
  },

  /** Tồn đọng theo từng ô (danh mục × tỉnh) — đầu vào của dashboard phủ sóng. */
  pendingByCategoryProvince() {
    return Listing.aggregate<{
      _id: { category: Types.ObjectId; province: string }
      count: number
    }>([
      { $match: { status: { $in: PENDING_STATUSES }, reach: LISTING_REACH.MARKETPLACE } },
      { $group: { _id: { category: '$category', province: '$provinceCode' }, count: { $sum: 1 } } },
    ])
  },

  /**
   * Danh sách cho bàn duyệt của org. KHÔNG đi qua `buildFilter`: hàm đó mặc định
   * `status: ACTIVE` để bảo vệ endpoint public, nên bỏ trống status ở đây sẽ ra "chỉ tin đang
   * hiển thị" thay vì "mọi trạng thái" — đúng ngược với thứ tab "Tất cả" của bàn duyệt cần.
   */
  async paginateForModeration(
    { status, category, q }: ModerationFilter,
    { skip, limit }: PaginationParams,
  ) {
    const filter: FilterQuery<IListingDocument> = {
      status: status ?? { $in: [...MODERATABLE_STATUSES] },
    }
    if (category) filter.category = new Types.ObjectId(category)
    if (q) {
      const term = new RegExp(escapeRegex(q), 'i')
      // Cả tên người đăng: quản trị thường lần theo một người bán đáng ngờ, không nhớ đúng tiêu
      // đề. `$or` ở đây an toàn với plugin: nó ghép scope bằng `.and()`, không ghi đè khoá `$or`.
      filter.$or = [{ title: term }, { posterName: term }]
    }
    const [items, total] = await Promise.all([
      Listing.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
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
            /*
             * `timezone` KHÔNG được thiếu: mặc định `$dateToString` cắt ngày theo UTC, nên
             * mọi tin đăng trước 7h sáng giờ Việt Nam rơi vào cột HÔM QUA. Cùng múi giờ với
             * `reportSeries` ngay trên — hai biểu đồ cùng một dữ liệu mà lệch cột là lỗi
             * không ai truy ra được từ giao diện.
             */
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORT_TIMEZONE },
            },
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
  async allImageRefs(): Promise<string[]> {
    const rows = await runUnscoped('image cleanup: gom URL ảnh của mọi tin', () =>
      Listing.find().select('images posterAvatar').lean().exec(),
    )
    return rows.flatMap((r) => [...r.images, r.posterAvatar])
  },
}
