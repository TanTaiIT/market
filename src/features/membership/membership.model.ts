import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  JOINED_VIA,
  JoinedVia,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUS,
  MembershipRole,
  MembershipStatus,
} from '../../common/constants'

/**
 * Quan hệ "người này thuộc org kia". Tách rời khỏi `users` để một tài khoản thuộc nhiều org.
 *
 * KHÔNG gắn `tenantPlugin`, cùng lý do với `User`: chính bảng này là thứ trả lời "request đang
 * đứng ở org nào và người gọi có quyền vào đó không", nên nó phải đọc được TRƯỚC khi tenant
 * scope tồn tại. Bù lại, mọi truy vấn ở đây đều mang `organizationId` tường minh — ép bằng
 * kiểu ở repository, không dựa vào kỷ luật.
 */
export interface IMembership {
  userId: Types.ObjectId
  organizationId: Types.ObjectId
  role: MembershipRole
  status: MembershipStatus
  /** Nhóm con. `null` khi org phẳng hoặc chưa được gán — xem `join-request.service.approve`. */
  unitId: Types.ObjectId | null
  joinedVia: JoinedVia
  /** Bậc uy tín TRONG org này. Uy tín không chuyển giữa các trục (§8.3). */
  trustLevel: number
  /** Số bài được duyệt sạch liên tiếp — nguồn để thăng bậc, reset khi bị từ chối. */
  cleanApprovals: number
  joinedAt: Date
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IMembershipDocument extends IMembership, Document {
  _id: Types.ObjectId
}

const membershipSchema = new Schema<IMembershipDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    role: {
      type: String,
      enum: Object.values(MEMBERSHIP_ROLES),
      default: MEMBERSHIP_ROLES.MEMBER,
    },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_STATUS),
      default: MEMBERSHIP_STATUS.ACTIVE,
    },
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    joinedVia: { type: String, enum: Object.values(JOINED_VIA), default: JOINED_VIA.REQUEST },
    trustLevel: { type: Number, default: 0, min: 0 },
    cleanApprovals: { type: Number, default: 0, min: 0 },
    joinedAt: { type: Date, default: () => new Date() },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Một người chỉ có một quan hệ với một org. Hai bản ghi cùng lúc nghĩa là thu hồi một cái vẫn
// còn cái kia — đúng loại lỗ hổng khó thấy nhất khi rà quyền.
membershipSchema.index({ userId: 1, organizationId: 1 }, { unique: true })
// Danh sách thành viên của org + màn duyệt hàng loạt. `joinedAt` ở đuôi để index cấp luôn THỨ
// TỰ mà danh bạ dùng (`sort({ joinedAt: 1 })`), không phải chỉ để lọc: thiếu nó thì Mongo kéo
// trọn danh bạ org ra rồi sort trong bộ nhớ. Không tốn thêm index nào — bản cũ là prefix.
membershipSchema.index({ organizationId: 1, status: 1, joinedAt: 1 })
// Hàng đợi duyệt tin theo nhóm con.
membershipSchema.index({ organizationId: 1, unitId: 1 })

export const Membership: Model<IMembershipDocument> = mongoose.model<IMembershipDocument>(
  'Membership',
  membershipSchema,
)
