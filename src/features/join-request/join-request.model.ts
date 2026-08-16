import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { JOIN_REQUEST_STATUS, JoinRequestStatus } from '../../common/constants'

/**
 * Đơn xin vào org. KHÔNG gắn `tenantPlugin`: người gửi đơn theo định nghĩa là người CHƯA thuộc
 * org, nên request của họ không có tenant scope để plugin bám vào. `organizationId` vì vậy là
 * tham số tường minh ở mọi truy vấn của repository này.
 */
export interface IJoinRequest {
  userId: Types.ObjectId
  organizationId: Types.ObjectId
  /** Họ tên tự khai — chủ org dùng để đối chiếu, không phải danh tính đã xác minh. */
  claimedName: string
  /** Nhóm con tự khai (dạng chữ). Người duyệt gán `unitId` thật lúc duyệt. */
  claimedUnit: string | null
  note: string | null
  status: JoinRequestStatus
  reviewedBy: Types.ObjectId | null
  reviewedAt: Date | null
  rejectReason: string | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface IJoinRequestDocument extends IJoinRequest, Document {
  _id: Types.ObjectId
}

const joinRequestSchema = new Schema<IJoinRequestDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    claimedName: { type: String, required: true, trim: true, maxlength: 100 },
    claimedUnit: { type: String, default: null, trim: true, maxlength: 100 },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: Object.values(JOIN_REQUEST_STATUS),
      default: JOIN_REQUEST_STATUS.PENDING,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null, trim: true, maxlength: 300 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Một người chỉ có một đơn đang chờ ở mỗi org — chặn spam gửi lại và chặn duyệt hai lần.
joinRequestSchema.index(
  { userId: 1, organizationId: 1 },
  { unique: true, partialFilterExpression: { status: JOIN_REQUEST_STATUS.PENDING } },
)
// Hàng đợi duyệt của org.
joinRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
// Trần số đơn đang chờ của một user + màn "đơn của tôi".
joinRequestSchema.index({ userId: 1, status: 1 })

export const JoinRequest: Model<IJoinRequestDocument> = mongoose.model<IJoinRequestDocument>(
  'JoinRequest',
  joinRequestSchema,
)
