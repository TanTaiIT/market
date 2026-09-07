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
  joinedAt: Date
  /**
   * Mốc người này xem hộp thư tới đâu — quyết định trạng thái đọc của thông báo PHÁT CHUNG
   * sinh tự động (xem `notification.model.ts` → `readBy`).
   *
   * Nằm ở đây chứ không ở `User`: nó là quan hệ giữa MỘT người và MỘT nhóm, y như `unitId` bên
   * trên. Đặt trên `User` thì mở hộp thư một lần là xoá dấu chưa-đọc của cả ba nhóm cùng lúc.
   *
   * `null` = chưa xem lần nào → mọi thông báo của nhóm đều là chưa đọc. Đúng cho thành viên
   * mới: `joinedAt` không thay được nó, vì người vào nhóm hôm nay không nên thấy tin của
   * năm trước là "chưa đọc" — `paginate` lọc theo `joinedAt` cho việc đó.
   */
  notificationsSeenAt: Date | null
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
    joinedAt: { type: Date, default: () => new Date() },
    notificationsSeenAt: { type: Date, default: null },
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
