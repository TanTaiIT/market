import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { hash, verify } from '@node-rs/bcrypt'
import { PLATFORM_ADMIN_ROLES, PlatformAdminRole } from '../../common/constants'

export interface IPlatformAdmin {
  email: string
  password: string
  name: string
  role: PlatformAdminRole
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IPlatformAdminDocument extends IPlatformAdmin, Document {
  _id: Types.ObjectId
  comparePassword(candidate: string): Promise<boolean>
}

const platformAdminSchema = new Schema<IPlatformAdminDocument>(
  {
    // Unique TOÀN CỤC (khác User): platform admin đứng ngoài mô hình tenant nên không có
    // organizationId để ghép vào compound unique.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false, minlength: 8 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    role: {
      type: String,
      enum: Object.values(PLATFORM_ADMIN_ROLES),
      default: PLATFORM_ADMIN_ROLES.SUPPORT,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

const BCRYPT_ROUNDS = 12

platformAdminSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next()
  this.password = await hash(this.password, BCRYPT_ROUNDS)
  next()
})

platformAdminSchema.methods.comparePassword = function comparePassword(candidate: string) {
  return verify(candidate, this.password)
}

// KHÔNG gắn tenantPlugin: collection này nằm ngoài mô hình tenant hoàn toàn.
export const PlatformAdmin: Model<IPlatformAdminDocument> = mongoose.model<IPlatformAdminDocument>(
  'PlatformAdmin',
  platformAdminSchema,
)
