import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { hash, verify } from '@node-rs/bcrypt'
import { ROLES, Role } from '../../common/constants'

export interface IUser {
  name: string
  email: string
  phone?: string
  password: string
  avatar: string
  role: Role
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
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // unique đã tự tạo index — thêm index: true nữa là khai báo trùng, mongoose sẽ warn.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, index: true },
    password: { type: String, required: true, select: false, minlength: 6 },
    avatar: { type: String, default: '' },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.USER },

    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    // Denormalize thống kê người bán để đọc nhanh
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },

    lastLoginAt: { type: Date },

    deletedAt: { type: Date, default: null, index: true },
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
