import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

/**
 * Hội thoại 1-1 giữa người mua và người bán, gắn vào đúng một tin đăng.
 *
 * `chainReadable` để mặc định **false**: học sinh trường A thấy được tin của trường B (Listing
 * bật chainReadable) nhưng chưa nhắn được cho người bán bên đó. Mở ra là việc của công tắc
 * `Chain.features.crossOrgChat` — xem `docs/architecture/admin-console.md` QĐ-2 — chứ không
 * phải bật cờ ở đây, vì lúc đó ghi cũng phải đổi theo và convention §1.2 nói chainReadable
 * chỉ nới chiều đọc.
 */

export interface IParticipant {
  user: Types.ObjectId
  /** Snapshot tên lúc mở hội thoại — §2.3 cấm populate sang User. */
  name: string
  /** `null` = chưa đọc lần nào. So với `lastMessageAt` để ra huy hiệu chưa đọc. */
  lastReadAt: Date | null
}

export interface IConversation {
  organizationId: Types.ObjectId
  listingId: Types.ObjectId
  /** Snapshot: tin có thể bị gỡ mà hội thoại vẫn phải đọc được. */
  listingTitle: string
  buyerId: Types.ObjectId
  sellerId: Types.ObjectId
  participants: IParticipant[]
  lastMessage: string
  lastMessageAt: Date
  lastSenderId: Types.ObjectId | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IConversationDocument extends IConversation, Document {
  _id: Types.ObjectId
}

const participantSchema = new Schema<IParticipant>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    lastReadAt: { type: Date, default: null },
  },
  { _id: false },
)

const conversationSchema = new Schema<IConversationDocument>(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
    listingTitle: { type: String, required: true, trim: true, maxlength: 150 },

    // Vai tường minh: người mua là người mở hội thoại, người bán không tự mở với chính mình.
    // Hai field này còn là thứ duy nhất dựng được unique index chặn hội thoại trùng.
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Trùng thông tin với buyerId/sellerId, nhưng đây mới là thứ index được cho câu hỏi
    // "hội thoại của tôi" — `$or` hai field không dùng chung một index được.
    participants: {
      type: [participantSchema],
      validate: [(arr: IParticipant[]) => arr.length === 2, 'Hội thoại phải có đúng 2 người'],
    },

    lastMessage: { type: String, default: '', maxlength: 2000 },
    lastMessageAt: { type: Date, default: Date.now },
    lastSenderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

conversationSchema.plugin(tenantPlugin)

conversationSchema.index({ organizationId: 1, 'participants.user': 1, lastMessageAt: -1 })
// Một người mua chỉ có đúng một hội thoại cho mỗi tin — bấm "Nhắn tin" lần hai là mở lại
// cái cũ chứ không đẻ thêm.
conversationSchema.index(
  { organizationId: 1, listingId: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// ── MESSAGE ─────────────────────────────────────────────────────────

export interface IMessage {
  organizationId: Types.ObjectId
  conversationId: Types.ObjectId
  senderId: Types.ObjectId
  senderName: string
  text: string
  createdAt: Date
  updatedAt: Date
}

export interface IMessageDocument extends IMessage, Document {
  _id: Types.ObjectId
}

const messageSchema = new Schema<IMessageDocument>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true, trim: true, maxlength: 100 },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
)

// Collection riêng chứ không nhúng mảng vào Conversation: một hội thoại dài sẽ đụng trần
// 16MB của document, và phân trang lịch sử thì không cắt được mảng nhúng.
messageSchema.plugin(tenantPlugin)

messageSchema.index({ organizationId: 1, conversationId: 1, createdAt: -1 })

function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

conversationSchema.pre(/^find/, excludeDeleted)
conversationSchema.pre('countDocuments', excludeDeleted)

export const Conversation: Model<IConversationDocument> = mongoose.model<IConversationDocument>(
  'Conversation',
  conversationSchema,
)

export const Message: Model<IMessageDocument> = mongoose.model<IMessageDocument>(
  'Message',
  messageSchema,
)
