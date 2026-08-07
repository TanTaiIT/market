import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { TENANT_STATUS, TenantStatus } from '../../common/constants'

export interface IChain {
  name: string
  slug: string
  /** Chain owner vẫn là User bình thường thuộc một org bất kỳ — quyền đến từ đây, không từ role. */
  ownerId: Types.ObjectId
  status: TenantStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IChainDocument extends IChain, Document {
  _id: Types.ObjectId
}

const chainSchema = new Schema<IChainDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(TENANT_STATUS), default: TENANT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Chain nằm TRÊN tenant, không thuộc tenant nào → không gắn tenantPlugin.
chainSchema.index({ slug: 1 }, { unique: true })
chainSchema.index({ ownerId: 1 }, { unique: true })

export const Chain: Model<IChainDocument> = mongoose.model<IChainDocument>('Chain', chainSchema)
