import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { hash, verify } from '@node-rs/bcrypt'
import { GENDER, Gender, VN_PROVINCE_NAMES } from '../../common/constants'
import type { VnProvinceName } from '../../common/constants/vnProvince'

/**
 * Tài khoản là TOÀN CỤC: không có `organizationId`.
 *
 * Đảo ngược có chủ ý của mô hình cũ (1 user thuộc đúng 1 org, `immutable`). Khi một người có
 * thể thuộc nhiều org — làm ở hai tổ chức, chuyển tổ chức vẫn giữ lịch sử — thì org không còn
 * là thuộc tính của user; nó là quan hệ, và quan hệ đó nằm ở `memberships`.
 *
 * Hệ quả trực tiếp: `email` unique TOÀN CỤC trở lại, và luồng đăng nhập không cần biết org.
 */
export interface IUser {
  name: string
  email: string
  phone?: string
  /** Vắng khi tài khoản đăng nhập bằng Google — xem khai báo schema. */
  password?: string
  googleId?: string
  avatar: string
  gender: Gender
  /**
   * Khu vực của chính người dùng — **RIÊNG TƯ**, không ra `PublicProfile`.
   *
   * Công dụng duy nhất: điền sẵn khu vực khi đăng tin. Nó KHÔNG phải nguồn của
   * `Listing.location` — mỗi tin vẫn tự mang khu vực riêng, vì người ta bán món đồ ở chỗ khác
   * nơi mình ở là chuyện thường.
   */
  location?: { province?: VnProvinceName; ward?: string; address?: string }
  /**
   * Có cho hiện số điện thoại trên tin đăng không. Mặc định **false**.
   *
   * Được đọc lúc TẠO TIN để quyết định `Listing.posterContact` — xem `listing.service.ts`.
   * Snapshot nên đổi công tắc không hồi tố tin đã đăng; đó là đánh đổi có chủ ý để không phải
   * populate `seller` khi trả tin (multi-tenant.convention §2.3).
   */
  showPhone: boolean
  /** `null` = chưa xác minh. Một cột thay vì cột boolean + cột thời điểm dễ lệch nhau. */
  emailVerifiedAt: Date | null
  isActive: boolean
  /**
   * Tăng lên là giết MỌI refresh token đã phát cho tài khoản này — xem `JwtPayload.ver`.
   * Không bao giờ giảm, và không mang ý nghĩa nào ngoài "so khớp hay không".
   */
  tokenVersion: number
  ratingAvg: number
  ratingCount: number
  lastLoginAt?: Date
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IUserDocument extends IUser, Document {
  _id: Types.ObjectId
  comparePassword(candidate: string): Promise<boolean>
}

const userSchema = new Schema<IUserDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    /*
     * KHÔNG còn `required`: tài khoản tạo bằng Google không có mật khẩu nào cả.
     *
     * Đừng 'chữa' bằng cách sinh một mật khẩu ngẫu nhiên cho họ — làm thế là lưu một chứng
     * chỉ có thật trong DB mà chủ tài khoản không biết, và một luồng quên-mật-khẩu sau này
     * sẽ lặng lẽ biến tài khoản Google thành tài khoản mật khẩu.
     */
    password: { type: String, select: false, minlength: 6 },
    /**
     * `sub` của Google — khoá ổn định của một tài khoản Google, KHÔNG đổi khi họ đổi email.
     *
     * `sparse` để hàng nghìn tài khoản mật khẩu (không có field này) không đụng unique index.
     * Khớp theo `sub` TRƯỚC khi khớp theo email: email đổi được, `sub` thì không.
     */
    googleId: { type: String, unique: true, sparse: true, default: undefined },
    avatar: { type: String, default: '' },
    gender: { type: String, enum: Object.values(GENDER), default: GENDER.UNDISCLOSED },
    // `_id: false`: subdoc thuần dữ liệu, không cần khoá riêng để tham chiếu tới.
    location: {
      type: new Schema(
        {
          // enum lặp lại tầng zod là cố ý, cùng lý do như `Listing.location`: seed/migration
          // ghi thẳng qua Mongoose, không đi qua zod.
          province: { type: String, trim: true, enum: VN_PROVINCE_NAMES },
          ward: { type: String, trim: true, maxlength: 100 },
          address: { type: String, trim: true, maxlength: 255 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Mặc định `false` — im lặng công khai số điện thoại của người dùng là thứ không bao giờ
    // được để làm mặc định.
    showPhone: { type: Boolean, default: false },

    emailVerifiedAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    // Tài khoản có TRƯỚC trường này không mang nó -> Mongoose hydrate thành 0, khớp với refresh
    // token cũ (cũng không có `ver`, đọc là 0). Không cần migration, không ai bị đá ra.
    tokenVersion: { type: Number, default: 0 },

    // Denormalize thống kê người bán để đọc nhanh
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },

    lastLoginAt: { type: Date },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.password
        delete r.__v
        return r
      },
    },
  },
)

// User KHÔNG dùng tenantPlugin: nó không thuộc tenant nào. Cách ly dữ liệu người dùng theo org
// nằm ở `memberships`, không ở bảng này.
// partialFilterExpression: thiếu nó thì một tài khoản đã xoá giữ chỗ email vĩnh viễn.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } })
// KHÔNG index `phone`: nó chỉ được đọc/ghi như một field hồ sơ, không call-site nào lọc theo
// nó. Thêm lại khi có đường "tìm người theo số" thật — index không ai dùng vẫn phải cập nhật
// mỗi lượt ghi và vẫn chiếm chỗ trong bộ nhớ.

const BCRYPT_ROUNDS = 12

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next()
  // Tài khoản Google không có mật khẩu: `hash(undefined)` ném, và nó ném ở giữa một lượt
  // `save()` nên lỗi hiện ra là 500 ở một đường không liên quan gì tới mật khẩu.
  if (!this.password) return next()
  this.password = await hash(this.password, BCRYPT_ROUNDS)
  next()
})

userSchema.methods.comparePassword = async function comparePassword(candidate: string) {
  /*
   * `false`, KHÔNG phải một lượt `verify` với `undefined`.
   *
   * Tài khoản chỉ-Google không có hash nào để so. `verify(candidate, undefined)` ném, và
   * `authService.login` không bắt — nên một lượt thử mật khẩu vào tài khoản Google sẽ trả
   * 500 thay vì 401. Ngoài chuyện xấu, nó còn là một kênh phân biệt: 500 nghĩa là "email
   * này tồn tại và là tài khoản Google", còn 401 thì không nói gì.
   */
  if (!this.password) return false
  return verify(candidate, this.password)
}

// Mặc định loại bản ghi đã soft-delete khỏi mọi query find
function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

userSchema.pre(/^find/, excludeDeleted)
// `countDocuments` KHÔNG khớp /^find/ (AGENT §10) — `countUsable` đếm master còn đăng nhập
// được, mà thiếu hook này thì đúng tài khoản vừa bị xoá lại được tính là "vẫn còn master".
userSchema.pre('countDocuments', excludeDeleted)

export const User: Model<IUserDocument> = mongoose.model<IUserDocument>('User', userSchema)
