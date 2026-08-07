import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { hash, verify } from '@node-rs/bcrypt'
import { ORG_ROLES, OrgRole } from '../../common/constants'

export interface IUser {
  organizationId: Types.ObjectId
  name: string
  email: string
  phone?: string
  password: string
  avatar: string
  role: OrgRole
  isEmailVerified: boolean
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
    // immutable: một user KHÔNG BAO GIỜ chuyển org — muốn chuyển thì tạo tài khoản mới
    // ở org mới (quyết định #2). Ràng buộc rẻ nhất chặn nguyên một lớp lỗi rò tenant.
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      immutable: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    // KHÔNG unique toàn cục: cùng email ở 2 org là 2 tài khoản riêng biệt (quyết định #2).
    // Unique thật nằm ở compound index bên dưới.
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    password: { type: String, required: true, select: false, minlength: 6 },
    avatar: { type: String, default: '' },
    role: { type: String, enum: Object.values(ORG_ROLES), default: ORG_ROLES.MEMBER },

    isEmailVerified: { type: Boolean, default: false },
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

// User KHÔNG dùng tenantPlugin: luồng login phải tìm user TRƯỚC khi có tenant context.
// Thay vào đó userRepository nhận organizationId tường minh ở mọi method — ép bằng kiểu,
// không dựa vào kỷ luật.
// partialFilterExpression: thiếu nó thì một tài khoản đã xoá giữ chỗ email vĩnh viễn.
userSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)
userSchema.index({ organizationId: 1, role: 1 })
userSchema.index({ organizationId: 1, phone: 1 })

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
userSchema.pre(/^find/, function excludeDeleted(this: mongoose.Query<unknown, unknown>, next) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
})

export const User: Model<IUserDocument> = mongoose.model<IUserDocument>('User', userSchema)
