import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  ListingStatus,
  ListingCondition,
} from '../../common/constants'

export interface IGeoLocation {
  type: 'Point'
  coordinates: [number, number] // [longitude, latitude]
  address?: string
  province?: string
  district?: string
}

export interface IListing {
  title: string
  slug?: string
  description: string
  price: number
  isNegotiable: boolean
  condition: ListingCondition
  images: string[]
  category: Types.ObjectId
  seller: Types.ObjectId
  location: IGeoLocation
  status: ListingStatus
  viewCount: number
  favoriteCount: number
  attributes: Map<string, string>
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
    province: { type: String, trim: true, index: true },
    district: { type: String, trim: true },
  },
  { _id: false },
)

const listingSchema = new Schema<IListingDocument>(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, index: true },
    description: { type: String, required: true, maxlength: 5000 },
    price: { type: Number, required: true, min: 0, index: true },
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

    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    location: { type: locationSchema, required: true },

    status: {
      type: String,
      enum: Object.values(LISTING_STATUS),
      default: LISTING_STATUS.PENDING,
      index: true,
    },

    viewCount: { type: Number, default: 0 },
    favoriteCount: { type: Number, default: 0 },

    // Thuộc tính động theo category (vd: xe -> {brand, year, km})
    attributes: { type: Map, of: String, default: {} },

    // Tự hết hạn qua TTL index (xem index bên dưới)
    expiresAt: { type: Date },

    deletedAt: { type: Date, default: null, index: true },
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

// --- Indexes (điểm mấu chốt hiệu năng) ---
listingSchema.index({ location: '2dsphere' }) // tìm "gần tôi"
listingSchema.index({ title: 'text', description: 'text' }) // full-text search cơ bản
listingSchema.index({ category: 1, status: 1, createdAt: -1 }) // filter phổ biến nhất
listingSchema.index({ seller: 1, status: 1, createdAt: -1 }) // tin của 1 người bán
// TTL: MongoDB tự xoá document khi qua expiresAt (0s sau thời điểm đó)
listingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

listingSchema.pre(/^find/, function excludeDeleted(this: mongoose.Query<unknown, unknown>, next) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
})

export const Listing: Model<IListingDocument> = mongoose.model<IListingDocument>(
  'Listing',
  listingSchema,
)
