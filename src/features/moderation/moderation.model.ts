import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { AUDIT_ACTION, AuditAction } from '../../common/constants'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

/**
 * Vết kiểm toán của thao tác quản trị.
 *
 * Panel "Vừa diễn ra" nhìn như trang trí, nhưng đây là hồ sơ trả lời tranh chấp "tin tôi bị
 * gỡ oan": ai gỡ, lúc nào, vì lý do gì. `summary` dựng sẵn lúc ghi để màn hình không phải
 * populate lại đối tượng có thể đã bị xoá.
 */
export interface IAuditLog {
  organizationId: Types.ObjectId
  /** `null` = hệ thống tự làm (vd job hết hạn tin). */
  actorId: Types.ObjectId | null
  actorName: string
  action: AuditAction
  targetType?: string
  targetId?: Types.ObjectId
  summary: string
  meta?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface IAuditLogDocument extends IAuditLog, Document {
  _id: Types.ObjectId
}

const auditLogSchema = new Schema<IAuditLogDocument>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, required: true, trim: true, maxlength: 100 },
    action: { type: String, enum: Object.values(AUDIT_ACTION), required: true },
    targetType: { type: String, trim: true, maxlength: 20 },
    targetId: { type: Schema.Types.ObjectId },
    summary: { type: String, required: true, trim: true, maxlength: 300 },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
)

// chainReadable: false — vết kiểm toán không rời khỏi trường sở tại, kể cả với chain owner.
auditLogSchema.plugin(tenantPlugin)

auditLogSchema.index({ organizationId: 1, createdAt: -1 })
// Log tăng vô hạn nếu không dọn. TTL BẮT BUỘC single-field (convention §3) nên nó không mang
// prefix organizationId — chấp nhận được vì đây là tiến trình nền, không nằm trên đường query.
const AUDIT_TTL_DAYS = 180
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_TTL_DAYS * 24 * 60 * 60 })

export const AuditLog: Model<IAuditLogDocument> = mongoose.model<IAuditLogDocument>(
  'AuditLog',
  auditLogSchema,
)
