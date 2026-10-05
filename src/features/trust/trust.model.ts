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
/** Án quản chế của master — xem `IUserTrust.probation`. */
export interface TrustProbation {
  reason: string
  byUserId: Types.ObjectId
  at: Date
  /** `null` = vô thời hạn, chỉ master gỡ. */
  until: Date | null
}

export interface IUserTrust {
  userId: Types.ObjectId
  /** Bậc uy tín hiện tại. Xem `trust.policy.ts` cho luật thăng/giáng. */
  level: number
  /** Số bài được duyệt sạch liên tiếp — nguồn để thăng bậc, reset khi bị từ chối. */
  cleanApprovals: number
  /**
   * Án QUẢN CHẾ của master (quyết định 1.12, 2026-09-26). Còn hiệu lực khi `until` là `null`
   * hoặc chưa tới — xem `probationActive`. Trong thời gian đó: không tự đăng, máy không duyệt,
   * và KHÔNG tự duyệt tin của chính mình dù có quyền quản trị nhóm. Bậc uy tín giữ nguyên: quản
   * chế là án về CÁCH người này dùng quyền, không phải về tin họ đăng.
   */
  probation: TrustProbation | null
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
    probation: {
      type: new Schema<TrustProbation>(
        {
          reason: { type: String, required: true, trim: true, maxlength: 300 },
          byUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          at: { type: Date, required: true },
          until: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
)

export const UserTrust: Model<IUserTrustDocument> = mongoose.model<IUserTrustDocument>(
  'UserTrust',
  userTrustSchema,
)
