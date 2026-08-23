import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Ví Xu — SỔ CÁI là nguồn sự thật, `balance` chỉ là bản cache đọc nhanh.
 *
 * Xu là tiền thật của khách (họ nạp VND để mua), nên mất dấu một giao dịch là mất khách kèm
 * một khiếu nại không có gì đối chứng. Vì vậy `wallets.balance` KHÔNG bao giờ được sửa tại
 * chỗ: mọi biến động đi qua `walletService.apply()`, ghi một dòng sổ cái bất biến và cộng trừ
 * số dư trong CÙNG một transaction Mongo.
 *
 * Cả hai collection KHÔNG gắn `tenantPlugin` — ví thuộc TÀI KHOẢN, mà tài khoản ở v2 là toàn
 * cục (cùng lý do với `UserTrust`, xem multi-tenant convention §1.3).
 *
 * **Yêu cầu hạ tầng**: Mongo phải chạy replica set (Atlas mặc định có; dev local cần
 * `--replSet`, test dùng `MongoMemoryReplSet`). Không có transaction thì cặp "ghi sổ + đổi số
 * dư" tách đôi được, và đó là đúng thứ file này tồn tại để ngăn.
 */
export interface IWallet {
  userId: Types.ObjectId
  /** Cache của `sum(xu_transactions.amount)`. Sai lệch = có người ghi tắt, không phải làm tròn. */
  balance: number
  createdAt: Date
  updatedAt: Date
}

export interface IWalletDocument extends IWallet, Document {
  _id: Types.ObjectId
}

const walletSchema = new Schema<IWalletDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
)

walletSchema.index({ userId: 1 }, { unique: true })

export const Wallet: Model<IWalletDocument> = mongoose.model<IWalletDocument>(
  'Wallet',
  walletSchema,
)

// ── SỔ CÁI ──────────────────────────────────────────────────────────────────

/**
 * Hiện chỉ `admin_adjust` có người sinh ra nó (master cộng/trừ tay). Số còn lại là chỗ ĐÃ ĐẶT
 * SẴN cho các giai đoạn sau — giữ lại có chủ ý: sổ cái là append-only nên một dòng ghi hôm nay
 * phải đọc được mãi mãi, và thêm giá trị vào enum sau này rẻ hơn nhiều so với đổi giá trị cũ.
 *
 * `topup` từng có đường sinh (đơn nạp + webhook VietQR) nhưng đã gỡ bỏ — xem
 * `docs/rules/xu-wallet.decision.md` §4.2.
 */
export const XU_TX_TYPES = [
  'topup',
  'post_fee',
  'product_purchase',
  'refund',
  'promo_grant',
  'admin_adjust',
] as const
export type XuTxType = (typeof XU_TX_TYPES)[number]

/**
 * Một dòng sổ cái. APPEND-ONLY: không có đường sửa, không có đường xoá — ghi sai thì ghi thêm
 * một dòng ngược dấu. Vì thế model này cố tình không có `deletedAt` lẫn hook soft-delete.
 */
export interface IXuTransaction {
  userId: Types.ObjectId
  /** Dương = cộng vào ví, âm = trừ đi. Không bao giờ bằng 0. */
  amount: number
  type: XuTxType
  /** Số dư NGAY SAU dòng này — cho phép dò lại lịch sử mà không phải cộng dồn cả bảng. */
  balanceAfter: number
  /**
   * Khoá chống ghi trùng, unique. Webhook của nhà thanh toán luôn bắn lại, và một cú double
   * click cũng gửi hai request — cả hai phải ra đúng MỘT dòng sổ.
   */
  idempotencyKey: string
  refs?: {
    listingId?: Types.ObjectId
    paymentId?: Types.ObjectId
    productCode?: string
  }
  /** Lý do đọc được — bắt buộc với `admin_adjust`, chốt ở service. */
  note: string
  createdAt: Date
}

export interface IXuTransactionDocument extends IXuTransaction, Document {
  _id: Types.ObjectId
}

const xuTransactionSchema = new Schema<IXuTransactionDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: [...XU_TX_TYPES], required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120 },
    refs: {
      type: new Schema(
        {
          listingId: { type: Schema.Types.ObjectId, ref: 'Listing' },
          // KHÔNG có `ref`: model `Payment` đã gỡ cùng tính năng nạp, khai `ref` tới một model
          // không tồn tại thì `populate()` ném `MissingSchemaError`. Chỉ giữ id trần.
          paymentId: { type: Schema.Types.ObjectId },
          productCode: { type: String, trim: true, maxlength: 40 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    note: { type: String, default: '', trim: true, maxlength: 300 },
  },
  // Chỉ `createdAt`: một dòng sổ cái không bao giờ được sửa, nên `updatedAt` là lời nói dối.
  { timestamps: { createdAt: true, updatedAt: false } },
)

xuTransactionSchema.index({ idempotencyKey: 1 }, { unique: true })
// Lịch sử ví của một người, mới nhất trước — đường đọc duy nhất của màn hình ví.
xuTransactionSchema.index({ userId: 1, createdAt: -1 })

export const XuTransaction: Model<IXuTransactionDocument> = mongoose.model<IXuTransactionDocument>(
  'XuTransaction',
  xuTransactionSchema,
)
