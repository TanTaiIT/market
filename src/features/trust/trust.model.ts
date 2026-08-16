import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Uy tín của một người trên TRỤC DANH MỤC, tách theo từng danh mục.
 *
 * Tồn tại vì uy tín KHÔNG chuyển giữa các trục (§8.3): 5 bài sạch trong một nhóm nhỏ không
 * được biến thành quyền tự đăng ở danh mục công khai toàn tỉnh — rủi ro lệch quá xa. Uy tín ở
 * trục org nằm ở `memberships.trustLevel`; bảng này là bản đối xứng cho trục còn lại.
 *
 * KHÔNG gắn `tenantPlugin`: trục danh mục không thuộc tổ chức nào.
 */
export interface IPublicTrust {
  userId: Types.ObjectId
  categoryId: Types.ObjectId
  level: number
  /** Số bài được duyệt sạch liên tiếp — nguồn để thăng bậc. Reset khi bị từ chối. */
  cleanApprovals: number
  createdAt: Date
  updatedAt: Date
}

export interface IPublicTrustDocument extends IPublicTrust, Document {
  _id: Types.ObjectId
}

const publicTrustSchema = new Schema<IPublicTrustDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    level: { type: Number, default: 0, min: 0 },
    cleanApprovals: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
)

publicTrustSchema.index({ userId: 1, categoryId: 1 }, { unique: true })

export const PublicTrust: Model<IPublicTrustDocument> = mongoose.model<IPublicTrustDocument>(
  'PublicTrust',
  publicTrustSchema,
)
