import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { TENANT_STATUS, TenantStatus } from '../../common/constants'

export interface IOrganization {
  /** `null` = org độc lập, không thuộc chain nào (quyết định #6). */
  chainId: Types.ObjectId | null
  name: string
  slug: string
  ownerId: Types.ObjectId
  status: TenantStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IOrganizationDocument extends IOrganization, Document {
  _id: Types.ObjectId
}

const organizationSchema = new Schema<IOrganizationDocument>(
  {
    chainId: { type: Schema.Types.ObjectId, ref: 'Chain', default: null },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(TENANT_STATUS), default: TENANT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Organization *là* tenant nên KHÔNG gắn tenantPlugin — truy cập nó đi qua
// organization.repository (chạy runUnscoped), đó là nơi duy nhất được phép.
organizationSchema.index({ slug: 1 }, { unique: true })
organizationSchema.index({ ownerId: 1 }, { unique: true })
// Đỡ toàn bộ nhóm route /chains/*: mọi request chain bắt đầu bằng "org nào thuộc chain này".
organizationSchema.index({ chainId: 1, status: 1 })

export const Organization: Model<IOrganizationDocument> = mongoose.model<IOrganizationDocument>(
  'Organization',
  organizationSchema,
)
