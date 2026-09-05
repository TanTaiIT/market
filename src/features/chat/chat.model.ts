import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Hội thoại 1-1 giữa người mua và người bán, gắn vào đúng một tin đăng.
 *
 * **KHÔNG gắn `tenantPlugin`** — hội thoại thuộc về HAI CON NGƯỜI, không thuộc về một tổ chức.
 * Cùng ngoại lệ đã duyệt với `Favorite`, `Notification`, `JoinRequest` và `UserTrust`: cái gì
 * thuộc về tài khoản thì không mang trục org, vì tài khoản ở v2 là toàn cục.
 *
 * Bản trước thì có, và nó khoá chặt đúng nhóm người dùng đông nhất: 110/160 tin đang chạy nằm
 * trên trục danh mục (`organizationId: null`), mà một hội thoại bắt buộc có org thì không có
 * chỗ nào để đặt chúng vào. Người mua không thuộc nhóm nào bấm "Nhắn tin" nhận
 * `Missing tenant context for "chat.open"` — lỗi của tầng hạ tầng, rò thẳng ra mặt người dùng.
 *
 * Chốt quyền thay thế nằm ở `participants`: đọc/ghi được một hội thoại khi và chỉ khi mình có
 * tên trong đó (`requireMembership` ở `chat.service`). Đó vốn đã là chốt THẬT — `tenantPlugin`
 * chỉ là một lớp thừa bên trên, và là lớp duy nhất từ chối người ngoài tổ chức.
 */

export interface IParticipant {
  user: Types.ObjectId
  /** Snapshot tên lúc mở hội thoại — §2.3 cấm populate sang User. */
  name: string
  /** Snapshot ảnh đại diện, cùng lý do. `''` = chưa đặt ảnh, client rơi về chữ viết tắt. */
  avatar: string
  /** `null` = chưa đọc lần nào. So với `lastMessageAt` để ra huy hiệu chưa đọc. */
  lastReadAt: Date | null
}

export interface IConversation {
  /**
   * Nhóm mà tin đăng thuộc về lúc mở hội thoại — chỉ để ATTRIBUTION, không còn là chốt quyền.
   * `null` khi tin nằm trên trục danh mục công khai, y như `Listing.organizationId`.
   */
  organizationId: Types.ObjectId | null
  listingId: Types.ObjectId
  /** Snapshot: tin có thể bị gỡ mà hội thoại vẫn phải đọc được. */
  listingTitle: string
  /**
   * Ảnh đầu của tin, snapshot cùng lúc với `listingTitle` — `''` khi tin không có ảnh nào.
   *
   * Snapshot chứ không populate sang `Listing` (§2.3), và cũng không phải để tiết kiệm một
   * lượt join: danh sách hội thoại trả 20 dòng một trang, mà mỗi dòng đi hỏi ảnh của tin
   * riêng là 20 truy vấn nữa trên đúng màn người dùng mở thường xuyên nhất.
   */
  listingImage: string
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
    avatar: { type: String, default: '', trim: true },
    lastReadAt: { type: Date, default: null },
  },
  { _id: false },
)

const conversationSchema = new Schema<IConversationDocument>(
  {
    // Khai TƯỜNG MINH, vì `tenantPlugin` không còn thêm nó hộ nữa — cùng cách `Notification`
    // đang làm. `default: null` để hội thoại về tin công khai không cần ai nhớ gán.
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
    listingTitle: { type: String, required: true, trim: true, maxlength: 150 },
    // `default: ''` chứ không `required`: tin không có ảnh là hợp lệ, và hội thoại cũ (mở
    // trước khi có field này) cũng phải đọc được — client rơi về dải màu suy từ id.
    listingImage: { type: String, default: '', trim: true },

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

/*
 * Cả hai index bỏ tiền tố `organizationId`.
 *
 * Không phải dọn dẹp mà là điều kiện để chúng còn dùng được: câu hỏi "hội thoại của tôi" giờ
 * lọc theo `participants.user` mà KHÔNG kèm org (người mua có thể chẳng thuộc org nào), nên
 * mọi index mở đầu bằng `organizationId` đều không khớp được nữa và Mongo sẽ quét cả bảng.
 */
conversationSchema.index({ 'participants.user': 1, lastMessageAt: -1 })
// Một người mua chỉ có đúng một hội thoại cho mỗi tin — bấm "Nhắn tin" lần hai là mở lại
// cái cũ chứ không đẻ thêm. Bỏ `organizationId` khỏi khoá KHÔNG nới lỏng gì: một tin chỉ
// thuộc đúng một org, nên (tin, người mua) vốn đã xác định duy nhất cặp đó.
conversationSchema.index(
  { listingId: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// ── MESSAGE ─────────────────────────────────────────────────────────

export interface IMessage {
  conversationId: Types.ObjectId
  senderId: Types.ObjectId
  senderName: string
  text: string
  /**
   * Id do client tự sinh trước khi gửi, server chỉ lưu và trả lại nguyên vẹn.
   *
   * Client vẽ bong bóng tin nhắn ngay lúc bấm gửi, lúc đó chưa có `_id` nào cả. Khi bản thật
   * quay về (REST hoặc socket), nó cần nhận ra "đây chính là bong bóng kia" để thay tại chỗ —
   * không có mã này thì chỉ còn cách dò theo nội dung, và bong bóng bị thay bằng một phần tử
   * mang khoá khác khiến danh sách dựng lại đúng dòng vừa gửi.
   *
   * Tuỳ chọn: tin từ client cũ hoặc từ đường khác vẫn hợp lệ khi thiếu nó.
   */
  clientMsgId?: string
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
    clientMsgId: { type: String, trim: true, maxlength: 64 },
  },
  { timestamps: true },
)

/*
 * Collection riêng chứ không nhúng mảng vào Conversation: một hội thoại dài sẽ đụng trần
 * 16MB của document, và phân trang lịch sử thì không cắt được mảng nhúng.
 *
 * KHÔNG có `organizationId`, kể cả để attribution: tin nhắn chỉ tới được qua `conversationId`,
 * mà quyền đọc hội thoại đó đã kiểm ở `requireMembership` trước khi truy vấn này chạy. Một
 * bản sao thứ hai của cùng thông tin chỉ là thứ để lệch khỏi hội thoại cha.
 */
messageSchema.index({ conversationId: 1, createdAt: -1 })

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
