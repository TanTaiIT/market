import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { PRODUCT_EFFECTS, ProductEffect } from '../listing/listing.pricing'

/**
 * Catalog gói tin — master xuất bản/sửa/gỡ qua API, thay cho mảng hardcode trong
 * `listing.pricing.ts` (mảng đó giờ chỉ còn là SEED khởi điểm). Nhờ nằm trong DB, master tạo
 * được nhiều mốc ưu đãi (featured_7d_sale…) mà không cần deploy.
 *
 * KHÔNG gắn `tenantPlugin` — cùng nhóm với `Category`/`BannedPhrase` (multi-tenant convention
 * §1.3): giá bán áp toàn nền tảng, một org không có catalog riêng.
 *
 * Vòng đời là cờ `enabled` (nháp → mở bán → ngừng bán), xoá cứng chỉ dành cho gói chưa từng
 * bán. Khi ví Xu vận hành, mỗi lượt mua sẽ SNAPSHOT điều khoản gói vào sổ cái — nên sửa/xoá
 * gói về sau không viết lại được lịch sử giao dịch.
 */
export interface IListingProduct {
  /** Định danh bất biến của gói — sổ cái tương lai tham chiếu bằng code, nên không cho sửa. */
  code: string
  name: string
  /** Lời chào hàng hiện trên FE — mốc ưu đãi khác nhau chủ yếu khác nhau ở đây và ở giá. */
  description: string
  effect: ProductEffect
  durationDays: number | null
  cooldownHours: number | null
  /** `null` = chưa chốt giá. Luật "mở bán phải có giá" chốt ở `productRuleErrors`. */
  price: { amount: number; currency: 'xu' } | null
  enabled: boolean
  /** Thứ tự hiển thị trên FE — master sắp, nhỏ đứng trước. */
  order: number
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface IListingProductDocument extends IListingProduct, Document {
  _id: Types.ObjectId
}

const listingProductSchema = new Schema<IListingProductDocument>(
  {
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    effect: { type: String, enum: [...PRODUCT_EFFECTS], required: true },
    durationDays: { type: Number, default: null, min: 1 },
    cooldownHours: { type: Number, default: null, min: 1 },
    price: {
      type: new Schema(
        {
          amount: { type: Number, required: true, min: 0 },
          currency: { type: String, enum: ['xu'], required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    enabled: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        // Ai tạo gói là chuyện quản trị nội bộ — catalog công khai không cần biết.
        delete r.createdBy
        return r
      },
    },
  },
)

listingProductSchema.index({ code: 1 }, { unique: true })

export const ListingProduct: Model<IListingProductDocument> =
  mongoose.model<IListingProductDocument>('ListingProduct', listingProductSchema)
