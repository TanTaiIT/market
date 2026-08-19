import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Tin đã lưu ("tim") của một tài khoản.
 *
 * **KHÔNG gắn `tenantPlugin`** — lý do và phần bù ghi ở hàng `Favorite` của bảng §1.3 trong
 * `docs/rules/multi-tenant.convention.md`, cùng khuôn đã duyệt cho `PublicTrust`.
 *
 * Bảng nối thay vì mảng trong `users`: danh sách đã lưu không có trần, còn mảng trong document
 * thì có (16MB), và mỗi lượt đọc hồ sơ sẽ kéo theo toàn bộ danh sách.
 *
 * Không soft delete: bỏ tim là xoá thật. Đây là dấu trang cá nhân, không phải hồ sơ xử lý cần
 * đọc lại về sau — giữ lại chỉ tạo ra một trạng thái "đã xoá nhưng vẫn chiếm chỗ unique index".
 */
export interface IFavorite {
  userId: Types.ObjectId
  listingId: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface IFavoriteDocument extends IFavorite, Document {
  _id: Types.ObjectId
}

const favoriteSchema = new Schema<IFavoriteDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
  },
  { timestamps: true },
)

// Nguồn của tính bất biến "một người lưu một tin đúng một lần" — service dựa thẳng vào lỗi
// duplicate key của index này thay vì find-rồi-create, nên hai lần bấm sát nhau vẫn ra một bản ghi.
favoriteSchema.index({ userId: 1, listingId: 1 }, { unique: true })
// Tab "Tin đã lưu" xếp mới nhất trước.
favoriteSchema.index({ userId: 1, createdAt: -1 })

export const Favorite: Model<IFavoriteDocument> = mongoose.model<IFavoriteDocument>(
  'Favorite',
  favoriteSchema,
)
