import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Mã xác thực email đang còn hiệu lực — **một bản ghi cho mỗi người dùng**, không phải một
 * lịch sử.
 *
 * Collection RIÊNG chứ không bốn cột trên `User`, vì ba lý do đều là lý do vận hành:
 *
 * 1. TTL index tự dọn. Bốn cột trên `User` thì mã hết hạn nằm lại vĩnh viễn trên bản ghi của
 *    mọi tài khoản từng đăng ký — một kho bằng chứng không ai cần và không ai nhớ dọn.
 * 2. `User` là bản ghi ĐỌC NÓNG nhất hệ thống (mọi request xác thực đều chạm). Nhét vào đó
 *    bốn cột chỉ sống 10 phút là bắt mọi lượt đọc mang theo chúng.
 * 3. Xoá tính năng = drop một collection, không phải một migration gỡ cột.
 *
 * KHÔNG gắn `tenantPlugin` — cùng lý do `User` không gắn: người dùng không thuộc tổ chức nào.
 */
/**
 * Hai cửa dùng CHUNG một bảng mã vì chúng giống nhau đến từng luật: hash bcrypt, sống 10 phút,
 * 5 lần gõ sai là chết, 60 giây giữa hai lượt gửi. Tách thành hai collection là hai bản sao của
 * cùng bộ luật, rồi một bên siết mà bên kia không.
 */
export const CODE_PURPOSE = {
  VERIFY_EMAIL: 'verify_email',
  RESET_PASSWORD: 'reset_password',
  /** Vé đổi được từ một mã đã nhập đúng — xem `issueTicket`. */
  RESET_TICKET: 'reset_ticket',
} as const
export type CodePurpose = (typeof CODE_PURPOSE)[keyof typeof CODE_PURPOSE]

export interface IEmailVerification {
  userId: Types.ObjectId
  /**
   * Mã này mở CỬA NÀO. Một người có thể cùng lúc có một mã xác thực email và một mã đặt lại
   * mật khẩu, và mã của cửa này KHÔNG được mở cửa kia — nên nó nằm trong cả khoá duy nhất lẫn
   * mọi lượt tra, không phải một nhãn để đọc cho biết.
   */
  purpose: CodePurpose
  /**
   * Hash bcrypt của mã, KHÔNG phải mã.
   *
   * Không dùng sha256 dù mã chỉ sống 10 phút: không gian mã là 10^6, nên một bản dump DB cộng
   * một vòng sha256 là dò xong toàn bộ trong vài giây. bcrypt biến việc đó thành hàng giờ cho
   * MỘT bản ghi. Giá phải trả là ~100ms mỗi lượt gửi/kiểm — không đáng kể với một luồng mỗi
   * người dùng chạy đúng một lần.
   */
  codeHash: string
  expiresAt: Date
  /** Số lần gõ sai. Chạm trần thì bản ghi bị xoá — xem `MAX_ATTEMPTS`. */
  attempts: number
  /** Mốc gửi gần nhất, cho hạn chờ gửi lại. */
  sentAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface IEmailVerificationDocument extends IEmailVerification, Document {
  _id: Types.ObjectId
}

/** 10 phút: đủ để mở hộp thư trên máy khác, ngắn để một mã đọc trộm không dùng được lúc rảnh. */
export const CODE_TTL_MS = 10 * 60 * 1000
/** 5 lần gõ sai là hết. 10^6 khả năng chia cho 5 lượt = xác suất mò trúng 1/200.000 mỗi mã. */
export const MAX_ATTEMPTS = 5
/** 60 giây giữa hai lượt gửi — chặn dùng nút "gửi lại" làm máy bắn thư vào hộp người khác. */
export const RESEND_COOLDOWN_MS = 60 * 1000

const emailVerificationSchema = new Schema<IEmailVerificationDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: Object.values(CODE_PURPOSE), required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, required: true },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true },
)

/*
 * TTL index — ngoại lệ (a) của quy tắc 13: Mongo không cho compound TTL, nên nó không có
 * prefix nào. Ở đây prefix cũng vô nghĩa vì collection không gắn tenant.
 *
 * Đây là DỌN RÁC, KHÔNG phải chốt hết hạn: Mongo chạy vòng quét TTL mỗi ~60 giây, nên một bản
 * ghi vẫn đọc được vài chục giây sau `expiresAt`. Chốt thật nằm ở service, so `expiresAt` với
 * `Date.now()` trên chính bản ghi vừa đọc. Bỏ vế đó đi là mở một cửa sổ dùng lại mã hết hạn
 * mà test sẽ không bắt được, vì test chạy nhanh hơn vòng quét.
 */
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

/*
 * Một mã sống cho mỗi CẶP (người, cửa) — không phải mỗi người. Khoá duy nhất chỉ trên `userId`
 * sẽ để một lượt xin mã đặt lại mật khẩu GHI ĐÈ mã xác thực email đang chờ, và người dùng mất
 * mã vừa nhận mà không có gì nói cho họ biết vì sao.
 */
emailVerificationSchema.index({ userId: 1, purpose: 1 }, { unique: true })

export const EmailVerification: Model<IEmailVerificationDocument> =
  mongoose.model<IEmailVerificationDocument>('EmailVerification', emailVerificationSchema)
