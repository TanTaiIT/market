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
  password: string
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
    password: { type: String, required: true, select: false, minlength: 6 },
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
userSchema.index({ phone: 1 })

const BCRYPT_ROUNDS = 12

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next()
  this.password = await hash(this.password, BCRYPT_ROUNDS)
  next()
})

userSchema.methods.comparePassword = function comparePassword(candidate: string) {
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
