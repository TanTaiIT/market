import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  PUSH_CATEGORIES,
  PUSH_OUTBOX_STATUS,
  PUSH_PLATFORMS,
  type PushCategory,
  type PushOutboxStatus,
  type PushPlatform,
} from '../../common/constants'

/*
 * Hai collection của push, cả hai KHÔNG gắn `tenantPlugin` (ngoại lệ có chủ ý của AGENT §12a):
 * thiết bị và hàng chờ gửi thuộc về NGƯỜI, không thuộc tổ chức — cùng lý do với `notifications`.
 * Người thuộc ba nhóm có một cái điện thoại, không phải ba cái. Vì không có tenant, index không
 * mở đầu bằng `organizationId` (AGENT §13 chỉ áp cho collection có tenant).
 */

// ── PUSH DEVICE ──────────────────────────────────────────────────────────────

export interface IPushDevice {
  userId: Types.ObjectId
  /** `ExponentPushToken[...]` — UNIQUE: một máy chỉ thuộc một người tại một thời điểm. */
  token: string
  /** Chừa đường thoát sang FCM/APNs trực tiếp mà không phải migrate collection. */
  provider: 'expo'
  platform: PushPlatform
  appVersion: string
  deviceName: string
  /** App đăng ký lại mỗi lần mở — mốc này cho biết máy còn được dùng không. */
  lastSeenAt: Date
  /** `null` = còn nhận; đặt khi Expo báo `DeviceNotRegistered` (gỡ app, tắt quyền vĩnh viễn). */
  disabledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IPushDeviceDocument extends IPushDevice, Document {
  _id: Types.ObjectId
}

const pushDeviceSchema = new Schema<IPushDeviceDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, trim: true, maxlength: 220 },
    provider: { type: String, enum: ['expo'], default: 'expo' },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    appVersion: { type: String, trim: true, maxlength: 40, default: '' },
    deviceName: { type: String, trim: true, maxlength: 100, default: '' },
    lastSeenAt: { type: Date, required: true },
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true },
)

/*
 * Unique theo token là chốt "đổi tài khoản trên cùng máy": B đăng nhập trên máy từng thuộc A thì
 * lượt đăng ký của B GHI ĐÈ dòng đó sang B, và A thôi nhận push trên máy không còn là của mình.
 */
pushDeviceSchema.index({ token: 1 }, { unique: true })
// Dispatcher: "thiết bị còn sống của những người này".
pushDeviceSchema.index({ userId: 1, disabledAt: 1 })
// Dọn máy lâu không mở app.
pushDeviceSchema.index({ lastSeenAt: 1 })

export const PushDevice: Model<IPushDeviceDocument> = mongoose.model<IPushDeviceDocument>(
  'PushDevice',
  pushDeviceSchema,
)

// ── PUSH OUTBOX ──────────────────────────────────────────────────────────────

export interface IPushTicket {
  deviceId: Types.ObjectId
  token: string
  ticketId: string | null
  /** Mã lỗi Expo ở ticket hoặc receipt (`DeviceNotRegistered`…). `null` = ổn. */
  error: string | null
  receiptChecked: boolean
}

export interface IPushOutbox {
  userId: Types.ObjectId
  category: PushCategory
  title: string
  body: string
  data: {
    path: string | null
    notificationId: string | null
    conversationId: string | null
  }
  /** Khoá gộp: tin chat cùng hội thoại dồn trong 30 giây thành một dòng. `null` = không gộp. */
  collapseKey: string | null
  coalescedCount: number
  status: PushOutboxStatus
  attempts: number
  nextAttemptAt: Date
  lockedAt: Date | null
  /** Id lượt claim của dispatcher — CAS: chỉ lượt ghi được claimId mới gửi dòng này. */
  claimId: string | null
  tickets: IPushTicket[]
  receiptsDueAt: Date | null
  /** Lý do `skipped` / `failed` / lần retry gần nhất — để trả lời "vì sao tôi không nhận được". */
  lastError: string | null
  sentAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IPushOutboxDocument extends IPushOutbox, Document {
  _id: Types.ObjectId
}

/** Hàng chờ chỉ là vết vận chuyển, không phải hồ sơ: hộp thư mới là bản gốc. */
export const PUSH_OUTBOX_RETENTION_DAYS = 7

const pushOutboxSchema = new Schema<IPushOutboxDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: PUSH_CATEGORIES, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    data: {
      path: { type: String, default: null },
      notificationId: { type: String, default: null },
      conversationId: { type: String, default: null },
    },
    collapseKey: { type: String, default: null },
    coalescedCount: { type: Number, default: 1 },
    status: {
      type: String,
      enum: Object.values(PUSH_OUTBOX_STATUS),
      default: PUSH_OUTBOX_STATUS.PENDING,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedAt: { type: Date, default: null },
    claimId: { type: String, default: null },
    tickets: {
      type: [
        new Schema<IPushTicket>(
          {
            deviceId: { type: Schema.Types.ObjectId, ref: 'PushDevice', required: true },
            token: { type: String, required: true },
            ticketId: { type: String, default: null },
            error: { type: String, default: null },
            receiptChecked: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    receiptsDueAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Dispatcher: dòng tới hạn gửi (pending) và dòng kẹt (sending quá lâu), theo thứ tự hạn.
pushOutboxSchema.index({ status: 1, nextAttemptAt: 1 })
pushOutboxSchema.index(
  { claimId: 1 },
  { partialFilterExpression: { claimId: { $type: 'string' } } },
)
// Gộp chat: "dòng đang chờ cùng khoá của người này, tạo gần đây". Partial vì đa số dòng không gộp.
pushOutboxSchema.index(
  { userId: 1, collapseKey: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { collapseKey: { $type: 'string' } } },
)
// Đọc receipt: dòng đã gửi, tới hạn hỏi.
pushOutboxSchema.index(
  { receiptsDueAt: 1 },
  { partialFilterExpression: { receiptsDueAt: { $type: 'date' } } },
)
// TTL — ngoại lệ (a) của AGENT §13: TTL index không compound được.
pushOutboxSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: PUSH_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 },
)

export const PushOutbox: Model<IPushOutboxDocument> = mongoose.model<IPushOutboxDocument>(
  'PushOutbox',
  pushOutboxSchema,
)
