import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { tenantPlugin } from '../../common/tenant/tenantPlugin'

/**
 * Nhóm con của org: lớp với trường, phòng ban với công ty, team với cộng đồng.
 *
 * TUỲ CHỌN theo đúng nghĩa: org phẳng (`capabilities.hasUnits = false`) không có bản ghi nào,
 * và lớp duyệt phân tầng tự suy biến đúng — không có tầng trung gian thì manager org duyệt
 * thẳng. Không có nhánh code riêng cho org phẳng.
 */
/*
 * NHÓM CON — bề mặt API đã gỡ, chỉ còn tầng dữ liệu.
 *
 * Tính năng chưa cần tới nên bốn endpoint `/org-units` và `PATCH /memberships/:userId`
 * (chuyển thành viên sang nhóm con) đã xoá. Model + repository ở lại vì code KHÔNG bị gỡ vẫn
 * đọc chúng: `notification.service` và `join-request.service` còn nhận `unitId` và kiểm bằng
 * `orgUnitRepository.findById`, ba script seed/migrate còn ghi bản ghi `OrgUnit`, và cột
 * `unitId` vẫn nằm trên Listing · Membership · Notification · RoleGrant.
 *
 * Hệ quả đang có: không đường nào TẠO được nhóm con qua HTTP nữa, nên hai nhánh nhận `unitId`
 * kia trên thực tế không ai đi vào — chúng ở lại để bật tính năng trở lại chỉ là revert.
 */
export interface IOrgUnit {
  organizationId: Types.ObjectId
  name: string
  /** Người duyệt tin của nhóm này. Quyền thật vẫn nằm ở `role_grants`; đây là con trỏ hiển thị. */
  moderatorId: Types.ObjectId | null
  /** Q4 chốt truy vấn PHẲNG ở vòng này; cột giữ sẵn để lên cây mà không phải migrate. */
  parentUnitId: Types.ObjectId | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IOrgUnitDocument extends IOrgUnit, Document {
  _id: Types.ObjectId
}

const orgUnitSchema = new Schema<IOrgUnitDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    moderatorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    parentUnitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

orgUnitSchema.plugin(tenantPlugin)

// Trùng tên nhóm trong cùng org là nguồn gán nhầm người lúc duyệt request tham gia.
orgUnitSchema.index(
  { organizationId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)
orgUnitSchema.index({ organizationId: 1, parentUnitId: 1 })

function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

orgUnitSchema.pre(/^find/, excludeDeleted)
orgUnitSchema.pre('countDocuments', excludeDeleted)

export const OrgUnit: Model<IOrgUnitDocument> = mongoose.model<IOrgUnitDocument>(
  'OrgUnit',
  orgUnitSchema,
)
