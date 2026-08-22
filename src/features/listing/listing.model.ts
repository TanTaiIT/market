import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  ListingStatus,
  ListingCondition,
  POST_VISIBILITY,
  PostVisibility,
  VN_PROVINCE_NAMES,
  VnProvinceName,
} from '../../common/constants'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'
import { AUTO_APPROVAL_REASONS, type AutoApprovalReason } from './listing.quota'

/**
 * Địa chỉ hành chính thuần, không có toạ độ — xem lý do bỏ geo ở `listing.schema.ts`.
 * Tên `IListingLocation` chứ không phải `IGeoLocation`: nó không còn là GeoJSON nữa, giữ tên
 * cũ sẽ khiến người sau tưởng vẫn `$near` được.
 */
export interface IListingLocation {
  address?: string
  /** Danh sách đóng 34 tỉnh/thành sau sáp nhập 01/07/2025 — validate ở `listing.schema.ts`. */
  province?: VnProvinceName
  /** Cấp thứ hai của mô hình 2 cấp (không còn quận/huyện ở giữa). */
  ward?: string
}

export interface IListing {
  /** `null` = tin của TRỤC DANH MỤC, không thuộc tổ chức nào. */
  organizationId: Types.ObjectId | null
  /** Khoá định tuyến hàng đợi duyệt (quyết định Q3), không phải `organizationId`. */
  visibility: PostVisibility
  /**
   * Snapshot CỨNG lúc tạo tin. Không tính động từ org hay user: org đổi địa chỉ hoặc người
   * đăng chuyển tổ chức sẽ làm tin cũ nhảy hàng đợi.
   */
  provinceCode: string | null
  /** Nhóm con của người đăng lúc đăng — staff nhóm con duyệt theo field này. */
  unitId: Types.ObjectId | null
  title: string
  slug?: string
  description: string
  price: number
  isNegotiable: boolean
  condition: ListingCondition
  images: string[]
  category: Types.ObjectId
  seller: Types.ObjectId
  posterName: string
  posterContact: string
  /** Snapshot ảnh đại diện lúc tạo tin — cùng lý do snapshot `posterName`: §2.3 cấm populate sang User. */
  posterAvatar: string
  /** Vắng khi người đăng không chọn khu vực — tin đó không lên bộ lọc tỉnh lẫn `/listings/nearby`. */
  location?: IListingLocation
  status: ListingStatus
  viewCount: number
  favoriteCount: number
  /**
   * Thuộc tính động theo danh mục, đã qua `validateAttributes` nên KIỂU LÀ THẬT: number cho
   * `odo`, boolean cho `warranty`, string[] cho `amenities`. Trước đây là `Map of String` —
   * đổi vì `storage: "256"` không bao giờ match `$gte: 128`, tức mọi field số đều không lọc
   * được theo khoảng.
   */
  attributes: Map<string, unknown>
  /**
   * Bản PHẲNG của `attributes` để lọc, chỉ gồm field `filterable`. Nhồi hết vào đây thì index
   * phình vô ích trên M0 512 MB (đặc tả §5.3).
   *
   * Mảng `{k, v}` chứ không phải object: Mongo không index được key động, còn mảng cặp thì
   * một index duy nhất phục vụ mọi field.
   */
  attrs: { k: string; v: unknown }[]
  /**
   * Template lúc tin được tạo. Form sửa tin phải dựng lại ĐÚNG bản này, không phải bản mới
   * nhất — nếu không, tin cũ hiện field chưa từng có và mất giá trị của field đã bỏ.
   */
  templateRef?: {
    id: Types.ObjectId
    version: number
    isFallback: boolean
  }
  /**
   * Vết của quyết định TỰ ĐĂNG lúc tin được tạo — chụp lại bậc uy tín tại thời điểm đó.
   *
   * Không ghi vào `AuditLog`: bảng đó gắn `tenantPlugin` và `recordAudit` bỏ qua khi không có
   * org (`subjectOrgId: null`), nên toàn bộ tin trục danh mục sẽ không có vết nào.
   */
  autoApproval?: {
    trustLevel: number
    reason: AutoApprovalReason
  }
  /** Vết của lượt duyệt gần nhất. Rỗng với tin chưa ai chạm tới. */
  moderation?: {
    reason?: string
    byUserId?: Types.ObjectId
    byName?: string
    at?: Date
  }
  expiresAt?: Date
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IListingDocument extends IListing, Document {
  _id: Types.ObjectId
}

const locationSchema = new Schema<IListingLocation>(
  {
    address: { type: String, trim: true },
    // enum lặp lại tầng zod là cố ý: seed/job/migration ghi thẳng qua Mongoose, không đi qua
    // `validate()`, nên đây là chốt chặn duy nhất cho các lối ghi không phải HTTP.
    province: { type: String, trim: true, enum: VN_PROVINCE_NAMES },
    ward: { type: String, trim: true },
  },
  { _id: false },
)

const listingSchema = new Schema<IListingDocument>(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String },
    description: { type: String, required: true, maxlength: 5000 },
    price: { type: Number, required: true, min: 0 },
    isNegotiable: { type: Boolean, default: false },

    condition: {
      type: String,
      enum: Object.values(LISTING_CONDITION),
      default: LISTING_CONDITION.USED,
    },

    // Ảnh: chỉ lưu URL (ảnh thật ở S3/Cloudinary), KHÔNG lưu binary trong Mongo
    images: {
      type: [String],
      validate: [(arr: string[]) => arr.length <= 12, 'Tối đa 12 ảnh'],
      default: [],
    },

    visibility: {
      type: String,
      enum: Object.values(POST_VISIBILITY),
      default: POST_VISIBILITY.ORG_INTERNAL,
      required: true,
    },
    // Chỉ bắt buộc với tin công khai: ở trục danh mục, tỉnh là thứ quyết định AI DUYỆT. Tin
    // nội bộ do org duyệt nên không cần — ép nó ở đây là phá lời hứa "khu vực là tuỳ chọn".
    provinceCode: {
      type: String,
      default: null,
      trim: true,
      enum: [...VN_PROVINCE_NAMES, null],
      required(this: { visibility?: string }) {
        return this.visibility === POST_VISIBILITY.PUBLIC
      },
    },
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },

    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Snapshot người đăng thay vì populate `seller`: người xem có thể thấy tin của org
    // khác, mà populate cross-org sẽ lôi cả email/role/phone của user org đó ra — rò rỉ
    // vượt xa nhu cầu "hiện tên + số liên hệ".
    // ponytail: snapshot một lần lúc tạo tin, không đồng bộ lại khi user đổi liên hệ;
    // thêm job resync nếu số cũ trên tin cũ thành vấn đề thật.
    posterName: { type: String, required: true, trim: true, maxlength: 100 },
    posterContact: { type: String, default: '', trim: true, maxlength: 50 },
    posterAvatar: { type: String, default: '', trim: true },

    location: { type: locationSchema, required: false },

    status: {
      type: String,
      enum: Object.values(LISTING_STATUS),
      default: LISTING_STATUS.PENDING,
    },

    viewCount: { type: Number, default: 0 },
    favoriteCount: { type: Number, default: 0 },

    // `Mixed` chứ không `String`: xem IListing.attributes. Đường ghi DUY NHẤT hợp lệ là
    // `categoryTemplateService.validateForCategory` — Mixed không tự validate được gì, nên
    // bỏ qua nó ở một call-site là để kiểu tuỳ tiện lọt thẳng vào DB.
    attributes: { type: Map, of: Schema.Types.Mixed, default: {} },

    // Sinh ở SERVICE, không phải hook `pre('save')` như bản phác thảo: `updateById` dùng
    // `findByIdAndUpdate` nên không kích hoạt `save`, và tin vừa sửa sẽ lặng lẽ giữ `attrs` cũ
    // — bộ lọc trả về tin không còn khớp điều kiện.
    attrs: {
      type: [new Schema({ k: { type: String }, v: { type: Schema.Types.Mixed } }, { _id: false })],
      default: [],
    },

    autoApproval: {
      type: new Schema(
        {
          trustLevel: { type: Number, required: true, min: 0 },
          reason: { type: String, enum: [...AUTO_APPROVAL_REASONS], required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },

    templateRef: {
      type: new Schema(
        {
          id: { type: Schema.Types.ObjectId, ref: 'CategoryTemplate', required: true },
          version: { type: Number, required: true },
          isFallback: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: undefined,
    },

    // Lý do từ chối hiện thẳng cho người đăng, nên snapshot tên người duyệt thay vì populate
    // (§2.3) — và giữ được cả khi tài khoản quản trị đó rời trường.
    moderation: {
      type: new Schema(
        {
          reason: { type: String, trim: true, maxlength: 300 },
          byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
          byName: { type: String, trim: true, maxlength: 100 },
          at: { type: Date },
        },
        { _id: false },
      ),
      default: undefined,
    },

    // Tự hết hạn qua TTL index (xem index bên dưới)
    expiresAt: { type: Date },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        // `attrs` là bản phẳng CHỈ để index tra — nó nhân đôi `attributes` vốn đã nằm ngay
        // cạnh. Gửi kèm là trả gấp đôi dữ liệu thuộc tính trên mỗi tin, nhân với 50 tin một
        // trang, cho một field không client nào đọc.
        delete r.attrs
        // `autoApproval` là hồ sơ kiểm duyệt nội bộ: nói cho người mua biết người bán này bậc
        // thấp là chuyện của hệ thống, không phải của trang tin. Muốn hiện cho CHÍNH chủ tin
        // thì mở bằng một endpoint riêng, đừng nới cái DTO mà ai cũng đọc được.
        delete r.autoApproval
        return r
      },
    },
  },
)

// Phải đứng TRƯỚC phần index: plugin mới là chỗ thêm field organizationId vào schema.
listingSchema.plugin(tenantPlugin, { dualAxis: true })

// --- Indexes ---
// HAI họ index vì có hai trục truy vấn, và query của trục này không dùng được index của trục
// kia: trục org luôn bắt đầu bằng `organizationId`, trục danh mục luôn bắt đầu bằng
// `visibility` (org của nó là null nên prefix organizationId vô dụng).
listingSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, category: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, seller: 1, status: 1, createdAt: -1 })
// Hàng đợi duyệt của staff nhóm con.
listingSchema.index({ organizationId: 1, unitId: 1, status: 1, createdAt: -1 })

/*
 * Bộ lọc khu vực. Bản cũ index `location.ward` mà KHÔNG có `location.province` — phục vụ một
 * query shape không tồn tại: `buildFilter` chỉ có tham số `province`, còn `findByArea` thì luôn
 * dùng cả cặp, không bao giờ lọc xã trần.
 *
 * `ward` cố tình KHÔNG nằm trong index, dù `findByArea` có lọc nó. Nhét vào giữa
 * `location.province` và `createdAt` thì `?province=` — bộ lọc chính của bảng tin — mất sort
 * index-backed và phải sort trong bộ nhớ TOÀN BỘ tin của tỉnh đó (đo được: 36 doc ở seed 1000
 * tin, và con số này lớn tuyến tính theo dữ liệu). Để `ward` làm residual filter thì
 * `/listings/nearby` quét thừa theo một hệ số CHẶN được (số xã mỗi tỉnh), còn `?province=` giữ
 * được cả thứ tự lẫn early-termination ở `limit`.
 *
 * Chú ý `location.province` (TÊN tỉnh, người dùng chọn để lọc) khác `provinceCode` (snapshot
 * định tuyến hàng đợi duyệt) — hai field khác nhau, index của cái này không đỡ cái kia.
 */
listingSchema.index({ organizationId: 1, 'location.province': 1, status: 1, createdAt: -1 })
listingSchema.index({ visibility: 1, 'location.province': 1, status: 1, createdAt: -1 })

/*
 * KHÔNG có index cho khoảng giá. Bản cũ có `{organizationId, price, status}` và nó vừa sai thứ
 * tự ESR (range `price` đứng trước equality `status`) vừa không bao giờ được chọn: mọi bảng tin
 * đều `sort({createdAt: -1})`, nên planner đi theo index có `createdAt` rồi lọc giá dọc đường —
 * đo bằng `npm run explain:indexes` thấy nó dùng SORT_MERGE trên hai index `…createdAt`, không
 * chạm index giá. Thêm lại thì phải kèm bản cho trục danh mục, và phải chứng minh bằng số.
 */

// Trục danh mục: bảng tin công khai (visibility + status) và hàng đợi của manager danh mục
// (visibility + category + tỉnh).
listingSchema.index({ visibility: 1, status: 1, createdAt: -1 })
listingSchema.index({ visibility: 1, category: 1, provinceCode: 1, status: 1, createdAt: -1 })
listingSchema.index({ visibility: 1, provinceCode: 1, status: 1, createdAt: -1 })

/*
 * "Tin của tôi" — NGOẠI LỆ của rule 13 (index trên collection có tenant phải mở đầu bằng
 * `organizationId`), và là ngoại lệ bắt buộc chứ không phải tiện tay.
 *
 * `paginateMine` chạy trong `runUnscoped`: nó scope theo NGƯỜI ĐĂNG, cố tình bỏ trục, để tin
 * công khai đang chờ duyệt của người không thuộc org nào vẫn hiện ra. Filter vì thế không có
 * `organizationId`, nên mọi index mở đầu bằng khoá đó đều vô dụng — đo được COLLSCAN quét trọn
 * 1000 tin để trả về 20.
 */
listingSchema.index({ seller: 1, createdAt: -1 })

// Index cho `attrs`, land CÙNG lượt với `?attrs=` trong `buildFilter` — đúng như ghi chú cũ ở
// đây hẹn. Đủ HAI bản, cùng lý do với hai họ index ở trên: trục org bắt đầu bằng
// `organizationId` (rule 13), trục danh mục bắt đầu bằng `visibility` vì org của nó là null.
//
// `category` đứng ngay sau khoá trục: bộ lọc thuộc tính LUÔN đi kèm danh mục (service chặn
// nếu thiếu), nên nó thu hẹp trước khi tới `attrs`.
listingSchema.index({ organizationId: 1, category: 1, status: 1, 'attrs.k': 1, 'attrs.v': 1 })
listingSchema.index({ visibility: 1, category: 1, status: 1, 'attrs.k': 1, 'attrs.v': 1 })

// Slug chỉ unique TRONG org, và tin đã xoá không giữ chỗ slug vĩnh viễn.
listingSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

/*
 * TTL BẮT BUỘC single-field — Mongo từ chối compound TTL. Nó là tiến trình dọn nền, không nằm
 * trên đường query nên không ảnh hưởng hiệu năng tenant.
 *
 * Index này XOÁ THẬT document khi tới hạn, không phải đổi `status` thành `expired`. Muốn "ẩn
 * mà giữ lịch sử" thì phải BỎ index này rồi thay bằng một job nền tự set `status = EXPIRED` —
 * hai cách loại trừ nhau, giữ cả hai thì job không bao giờ kịp chạy trước khi Mongo xoá mất.
 */
listingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// KHÔNG có text index: scope đọc là `$in [...readableOrgIds]`, mà text index bắt buộc
// equality trên prefix -> vỡ ngay ở route tìm kiếm chính. Xem listing.repository.buildFilter
// để biết cách `?q=` đang chạy tạm và đường nâng cấp.

function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

listingSchema.pre(/^find/, excludeDeleted)
// `countDocuments` KHÔNG khớp /^find/ — thiếu hook này thì total của pagination
// đếm cả tin đã soft-delete, lệch hẳn với items trả về.
listingSchema.pre('countDocuments', excludeDeleted)

export const Listing: Model<IListingDocument> = mongoose.model<IListingDocument>(
  'Listing',
  listingSchema,
)
