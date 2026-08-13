import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  ListingStatus,
  ListingCondition,
} from '../../common/constants'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

export interface IGeoLocation {
  type: 'Point'
  coordinates: [number, number] // [longitude, latitude]
  address?: string
  province?: string
  district?: string
}

export interface IListing {
  organizationId: Types.ObjectId
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
  location: IGeoLocation
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

const locationSchema = new Schema<IGeoLocation>(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [lng, lat]
    address: { type: String, trim: true },
    province: { type: String, trim: true },
    district: { type: String, trim: true },
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

    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Snapshot người đăng thay vì populate `seller`: user trong chain xem được tin của org
    // khác, mà populate cross-org sẽ lôi cả email/role/phone của user org đó ra — rò rỉ
    // vượt xa nhu cầu "hiện tên + số liên hệ".
    // ponytail: snapshot một lần lúc tạo tin, không đồng bộ lại khi user đổi liên hệ;
    // thêm job resync nếu số cũ trên tin cũ thành vấn đề thật.
    posterName: { type: String, required: true, trim: true, maxlength: 100 },
    posterContact: { type: String, default: '', trim: true, maxlength: 50 },

    location: { type: locationSchema, required: true },

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
// chainReadable: chỉ Listing được đọc xuyên org trong cùng chain (quyết định #15).
listingSchema.plugin(tenantPlugin, { chainReadable: true })

// --- Indexes ---
// Mọi query đều bắt đầu bằng organizationId nên nó phải là khoá đầu tiên; index không có
// prefix này sẽ khiến org lớn nhất làm chậm mọi org còn lại.
listingSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, category: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, seller: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, 'location.province': 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, price: 1, status: 1 })
listingSchema.index({ organizationId: 1, location: '2dsphere' })

// Slug chỉ unique TRONG org, và tin đã xoá không giữ chỗ slug vĩnh viễn.
listingSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// TTL BẮT BUỘC single-field — Mongo từ chối compound TTL. Nó là tiến trình dọn nền,
// không nằm trên đường query nên không ảnh hưởng hiệu năng tenant.
listingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// KHÔNG có text index: scope đọc mặc định là `$in [...chainOrgIds]`, mà text index có
// prefix bắt buộc equality trên prefix -> vỡ ngay ở route tìm kiếm chính. Xem
// listing.repository.buildFilter để biết cách `?q=` đang chạy tạm và đường nâng cấp.

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
