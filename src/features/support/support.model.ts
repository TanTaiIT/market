import mongoose, { Schema, Document, Types } from 'mongoose'

/** Ai viết một tin nhắn. Chỉ hai phía — đây là kênh người dùng ↔ master, không phải nhóm chat. */
export const SUPPORT_SIDE = { USER: 'user', MASTER: 'master' } as const
export type SupportSide = (typeof SUPPORT_SIDE)[keyof typeof SUPPORT_SIDE]

/** Dài hơn tin nhắn chat thường: người ta mô tả sự cố, không nhắn "còn hàng không". */
export const SUPPORT_BODY_MAX = 2000

export interface ISupportMessage {
  from: SupportSide
  body: string
  at: Date
  /** Ai bấm gửi. Phía master có nhiều người, cần biết master NÀO đã trả lời. */
  byUserId: Types.ObjectId
}

export interface ISupportThread {
  userId: Types.ObjectId
  messages: ISupportMessage[]
  lastUserAt: Date | null
  lastMasterAt: Date | null
  /** Mốc người dùng mở luồng lần cuối — chấm đỏ trên icon là `lastMasterAt > userReadAt`. */
  userReadAt: Date | null
  /** Mốc master xem lần cuối — hàng đợi là `lastUserAt > masterReadAt`. */
  masterReadAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ISupportThreadDocument extends ISupportThread, Document {
  _id: Types.ObjectId
}

/**
 * MỘT luồng cho MỖI người dùng, sống mãi — không phải hệ thống ticket.
 *
 * Người dùng nghĩ về thứ này như "nhắn cho admin", giống một cuộc trò chuyện chứ không phải
 * một phiếu yêu cầu có vòng đời mở/đóng. Một luồng duy nhất bỏ được cả trạng thái
 * `open/closed`, màn danh sách ticket phía người dùng, và câu hỏi "tạo phiếu mới hay trả lời
 * phiếu cũ" — ba thứ không ai hỏi tới ở quy mô này.
 *
 * KHÔNG gắn `tenantPlugin`: đây là kênh giữa một người và ĐỘI NGŨ NỀN TẢNG, không thuộc tổ
 * chức nào. Người không ở nhóm nào vẫn phải nhắn được, và người ở ba nhóm cũng chỉ có một
 * luồng. Cùng lý do `role_grants` không gắn plugin, và cùng cái bẫy mà `notification.model`
 * đã ghi lại: gỡ plugin thì mọi field phạm vi phải khai tường minh.
 *
 * Nhúng `messages` vào luồng thay vì tách collection: một cuộc hỗ trợ có vài chục tin là cùng,
 * và luôn được đọc trọn gói. Tách ra là thêm một lượt truy vấn cho mọi lần mở.
 */
const messageSchema = new Schema<ISupportMessage>(
  {
    from: { type: String, enum: Object.values(SUPPORT_SIDE), required: true },
    body: { type: String, required: true, trim: true, maxlength: SUPPORT_BODY_MAX },
    at: { type: Date, default: Date.now },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
)

const supportThreadSchema = new Schema<ISupportThreadDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    messages: { type: [messageSchema], default: [] },
    lastUserAt: { type: Date, default: null },
    lastMasterAt: { type: Date, default: null },
    userReadAt: { type: Date, default: null },
    masterReadAt: { type: Date, default: null },
  },
  { timestamps: true },
)

/*
 * Một luồng một người — unique là thứ BẢO ĐẢM điều đó, không phải kỷ luật ở service.
 *
 * `support.service.send` bắt lỗi 11000 để xử ca hai thiết bị bấm gửi cùng lúc; thiếu index thì
 * nhánh đó âm thầm không bao giờ chạy và người dùng có hai luồng, mỗi luồng một nửa câu chuyện.
 * Nhớ chạy `npm run sync-indexes` sau khi deploy — production tắt `autoIndex`.
 */
supportThreadSchema.index({ userId: 1 }, { unique: true })

/** Hàng đợi của master: luồng có tin mới nhất của người dùng lên đầu. */
supportThreadSchema.index({ lastUserAt: -1 })

export const SupportThread = mongoose.model<ISupportThreadDocument>(
  'SupportThread',
  supportThreadSchema,
)
