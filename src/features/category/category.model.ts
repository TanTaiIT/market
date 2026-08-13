import mongoose, { Schema, Document, Model, Types } from 'mongoose'

export interface ICategory {
  name: string
  slug: string
  icon: string
  order: number
  isActive: boolean
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ICategoryDocument extends ICategory, Document {
  _id: Types.ObjectId
}

const categorySchema = new Schema<ICategoryDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 60 },
    icon: { type: String, default: '', trim: true, maxlength: 8 },
    order: { type: Number, default: 0 },
    // Tắt thay vì xoá khi danh mục thôi được dùng: tin cũ vẫn trỏ vào nó, xoá là để lại
    // `Listing.category` mồ côi.
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        return r
      },
    },
  },
)

// KHÔNG gắn tenantPlugin — đây là ngoại lệ đã duyệt trong multi-tenant.convention §1.3
// (quyết định #7): danh mục là từ điển dùng chung toàn hệ thống, không mang dữ liệu của
// khách hàng nào. Hệ quả: §0.6 (index prefix organizationId) không áp dụng ở đây, và ghi
// là việc của platform-admin chứ không phải quản trị một trường.
//
// Model này tồn tại là điều kiện cần để `listing.model.ts` dùng được `ref: 'Category'`:
// populate vào model chưa đăng ký ném MissingSchemaError lúc chạy (convention §2.3).

categorySchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } })
categorySchema.index({ isActive: 1, order: 1 })

function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

categorySchema.pre(/^find/, excludeDeleted)
// `countDocuments` KHÔNG khớp /^find/ (AGENT §10) — service đếm để chặn trùng tên nên
// thiếu hook này thì danh mục đã xoá vẫn tính vào.
categorySchema.pre('countDocuments', excludeDeleted)

export const Category: Model<ICategoryDocument> = mongoose.model<ICategoryDocument>(
  'Category',
  categorySchema,
)
