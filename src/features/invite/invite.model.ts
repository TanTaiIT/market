import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { INVITE_CHANNELS, INVITE_STATUS, InviteChannel, InviteStatus } from '../../common/constants'

/**
 * Lời mời vào một tổ chức.
 *
 * **KHÔNG gắn `tenantPlugin`** — cùng lý do đã duyệt cho `JoinRequest` (multi-tenant.convention
 * §1.3): người được mời theo định nghĩa **chưa** thuộc org đích, nên lượt đọc lúc họ bấm vào
 * link không có scope nào để plugin dựa vào. Bù lại, mọi truy vấn ở repository đều mang
 * `organizationId` tường minh — ép bằng kiểu, không dựa vào kỷ luật.
 *
 * Một model, hai dạng:
 * - `direct` — tra ra tài khoản đang tồn tại: gửi kèm thông báo trong app, và CHỈ người đó
 *   nhận được. `invitedUserId` là chốt chặn.
 * - `link` — không tra ra ai: chỉ còn cái token, ai cầm cũng vào được. Admin tự gửi qua Zalo
 *   hay Messenger. Đúng bản chất "link mời", và cũng là lý do nó hết hạn.
 *
 * Cả hai đều có token để đường chấp nhận chỉ có MỘT nhánh code.
 */
export interface IInvite {
  organizationId: Types.ObjectId
  channel: InviteChannel
  /** Email đã lowercase, hoặc số điện thoại đã bỏ khoảng trắng. Admin cần đọc lại "đã mời ai". */
  value: string
  kind: 'direct' | 'link'
  /** Băm, không lưu thô — rò DB không được phép biến thành rò lời mời. */
  tokenHash: string
  invitedUserId: Types.ObjectId | null
  status: InviteStatus
  invitedBy: Types.ObjectId
  expiresAt: Date
  acceptedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IInviteDocument extends IInvite, Document {
  _id: Types.ObjectId
}

const inviteSchema = new Schema<IInviteDocument>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    channel: { type: String, enum: Object.values(INVITE_CHANNELS), required: true },
    value: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['direct', 'link'], required: true },
    tokenHash: { type: String, required: true },
    invitedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: Object.values(INVITE_STATUS), default: INVITE_STATUS.PENDING },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Đường vào của người bấm link: tra bằng token, không có org scope nào lúc đó.
inviteSchema.index({ tokenHash: 1 }, { unique: true })
// Danh sách "đã mời ai" của bàn quản trị.
inviteSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
// Hộp thư lời mời của một người.
inviteSchema.index({ invitedUserId: 1, status: 1 })
// Mời trùng một địa chỉ khi lời mời cũ còn hiệu lực là hai lời mời cùng sống — thu hồi một cái
// vẫn còn cái kia, đúng loại lỗ hổng khó thấy nhất khi rà quyền.
inviteSchema.index(
  { organizationId: 1, channel: 1, value: 1 },
  { unique: true, partialFilterExpression: { status: INVITE_STATUS.PENDING } },
)

export const Invite: Model<IInviteDocument> = mongoose.model<IInviteDocument>(
  'Invite',
  inviteSchema,
)
