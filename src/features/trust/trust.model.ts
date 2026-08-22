import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Uy tín của một TÀI KHOẢN. Một người một bậc, dùng chung cho mọi luồng đăng tin.
 *
 * **Đây là thay đổi so với v2 gốc.** Bản trước tách đôi: `memberships.trustLevel` cho tin nội
 * bộ và `PublicTrust` theo từng danh mục cho tin công khai, với lý do "5 bài sạch trong một
 * nhóm nhỏ không được biến thành quyền tự đăng ở danh mục công khai toàn tỉnh" (§8.3). Quyết
 * định mới: gộp làm một, uy tín đi theo con người chứ không theo chỗ họ đăng.
 *
 * Đánh đổi phải biết và phải canh: người xây đủ 10 bài sạch ở một tổ chức nhỏ giờ tự đăng
 * được thẳng ra trục công khai. Chốt chặn còn lại nằm ở `Category.requireManualReview` và
 * `recentRejections` — hai thứ đó giờ gánh phần việc mà việc tách trục từng gánh.
 *
 * KHÔNG gắn `tenantPlugin`: uy tín thuộc tài khoản, mà tài khoản ở v2 là toàn cục. Gắn plugin
 * thì cùng một người đổi org lại thấy một bậc khác — đúng thứ vừa quyết định là bỏ.
 */
export interface IUserTrust {
  userId: Types.ObjectId
  /** Bậc uy tín hiện tại. Xem `trust.policy.ts` cho luật thăng/giáng. */
  level: number
  /** Số bài được duyệt sạch liên tiếp — nguồn để thăng bậc, reset khi bị từ chối. */
  cleanApprovals: number
  createdAt: Date
  updatedAt: Date
}

export interface IUserTrustDocument extends IUserTrust, Document {
  _id: Types.ObjectId
}

const userTrustSchema = new Schema<IUserTrustDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    level: { type: Number, default: 0, min: 0 },
    cleanApprovals: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
)

export const UserTrust: Model<IUserTrustDocument> = mongoose.model<IUserTrustDocument>(
  'UserTrust',
  userTrustSchema,
)
