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
  attributes: Map<string, string>
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

    // Thuộc tính động theo category (vd: xe -> {brand, year, km})
    attributes: { type: Map, of: String, default: {} },

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
listingSchema.index({ organizationId: 1, 'location.ward': 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, price: 1, status: 1 })
// Hàng đợi duyệt của staff nhóm con.
listingSchema.index({ organizationId: 1, unitId: 1, status: 1, createdAt: -1 })

// Trục danh mục: bảng tin công khai (visibility + status) và hàng đợi của manager danh mục
// (visibility + category + tỉnh).
listingSchema.index({ visibility: 1, status: 1, createdAt: -1 })
listingSchema.index({ visibility: 1, category: 1, provinceCode: 1, status: 1, createdAt: -1 })
listingSchema.index({ visibility: 1, provinceCode: 1, status: 1, createdAt: -1 })

// Slug chỉ unique TRONG org, và tin đã xoá không giữ chỗ slug vĩnh viễn.
listingSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// TTL BẮT BUỘC single-field — Mongo từ chối compound TTL. Nó là tiến trình dọn nền,
// không nằm trên đường query nên không ảnh hưởng hiệu năng tenant.
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
