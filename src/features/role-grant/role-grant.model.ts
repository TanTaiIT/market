import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  SYSTEM_ROLES,
  SCOPE_TYPES,
  SystemRole,
  ScopeType,
  isWardOfProvince,
} from '../../common/constants'

/**
 * Một lần cấp quyền = một bản ghi. Không có cột `role` trên `users`: một người vừa có thể là
 * manager danh mục "Việc làm" ở TP.HCM, vừa là staff của một org — nhét vào một cột thì phải
 * viết `if` khắp nơi.
 *
 * Bảng này APPEND-ONLY: thu hồi là set `revokedAt`, không xoá. Bản ghi cũ chính là vết kiểm
 * toán trả lời "ai cho người này quyền đó, lúc nào".
 */
export interface IRoleGrant {
  userId: Types.ObjectId
  role: SystemRole
  scopeType: ScopeType
  orgId: Types.ObjectId | null
  unitId: Types.ObjectId | null
  categoryId: Types.ObjectId | null
  /** Rỗng = TOÀN QUỐC (chỉ có nghĩa với `category_province`). */
  provinceCodes: string[]
  /**
   * Phường/xã của scope `category_ward`, kèm ĐÚNG một tỉnh trong `provinceCodes`.
   *
   * Vì sao phải đi cặp: tên phường không unique toàn quốc — 243 tên lặp giữa các tỉnh, "Xã Tân
   * Tiến" có 7 nơi — nên một mình tên phường không định danh được ô nào. Muốn hai tỉnh thì cấp
   * hai lần; một grant là MỘT lần cấp quyền, không phải một cái giỏ.
   */
  wardCodes: string[]
  /** `null` = seed/migration dựng, không phải người thật cấp. */
  grantedBy: Types.ObjectId | null
  grantedAt: Date
  revokedAt: Date | null
  revokedBy: Types.ObjectId | null
}

export interface IRoleGrantDocument extends IRoleGrant, Document {
  _id: Types.ObjectId
}

/** Role nào đi được với scope nào. Sai cặp = quyền không có nghĩa, chặn ngay ở model. */
const ROLE_SCOPES: Record<SystemRole, ScopeType[]> = {
  [SYSTEM_ROLES.MASTER]: [SCOPE_TYPES.SYSTEM],
  [SYSTEM_ROLES.MANAGER]: [
    SCOPE_TYPES.ORG,
    SCOPE_TYPES.CATEGORY_PROVINCE,
    SCOPE_TYPES.CATEGORY_WARD,
  ],
  // staff ở `category_province` là cách manager danh mục chia tải: §5.3 nói manager cấp staff
  // trong scope của mình, mà scope của họ là (danh mục × tỉnh).
  [SYSTEM_ROLES.STAFF]: [
    SCOPE_TYPES.ORG,
    SCOPE_TYPES.ORG_UNIT,
    SCOPE_TYPES.CATEGORY_PROVINCE,
    SCOPE_TYPES.CATEGORY_WARD,
  ],
}

/** Field nào BẮT BUỘC có và field nào BẮT BUỘC rỗng, theo từng scope. */
const SCOPE_SHAPE: Record<ScopeType, { required: (keyof IRoleGrant)[] }> = {
  [SCOPE_TYPES.SYSTEM]: { required: [] },
  [SCOPE_TYPES.ORG]: { required: ['orgId'] },
  [SCOPE_TYPES.ORG_UNIT]: { required: ['orgId', 'unitId'] },
  [SCOPE_TYPES.CATEGORY_PROVINCE]: { required: ['categoryId'] },
  // Tỉnh + phường không nằm trong `required` vì chúng là ARRAY: `!this.get(field)` không bắt
  // được mảng rỗng. Hình dạng của chúng do khối kiểm riêng dưới `enforceScopeShape` lo.
  [SCOPE_TYPES.CATEGORY_WARD]: { required: ['categoryId'] },
}

const SCOPE_FIELDS = ['orgId', 'unitId', 'categoryId'] as const

const roleGrantSchema = new Schema<IRoleGrantDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: Object.values(SYSTEM_ROLES), required: true },
    scopeType: { type: String, enum: Object.values(SCOPE_TYPES), required: true },

    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    provinceCodes: { type: [String], default: [] },
    wardCodes: { type: [String], default: [] },

    grantedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    grantedAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
)

// Ràng buộc hình dạng nằm ở model chứ không ở service: service là nơi người ta quên, model là
// nơi mọi đường ghi (kể cả seed và migration) đều phải đi qua.
roleGrantSchema.pre('validate', function enforceScopeShape(next) {
  const allowed = ROLE_SCOPES[this.role]
  if (!allowed?.includes(this.scopeType)) {
    return next(new Error(`Role "${this.role}" không dùng được với scope "${this.scopeType}"`))
  }

  const { required } = SCOPE_SHAPE[this.scopeType]
  for (const field of required) {
    if (!this.get(field)) return next(new Error(`scope "${this.scopeType}" thiếu ${field}`))
  }
  for (const field of SCOPE_FIELDS) {
    if (!required.includes(field) && this.get(field)) {
      return next(new Error(`scope "${this.scopeType}" không được mang ${field}`))
    }
  }
  const geoScopes: ScopeType[] = [SCOPE_TYPES.CATEGORY_PROVINCE, SCOPE_TYPES.CATEGORY_WARD]
  if (!geoScopes.includes(this.scopeType) && this.provinceCodes.length > 0) {
    return next(new Error('provinceCodes chỉ có nghĩa với scope trục danh mục'))
  }

  if (this.scopeType === SCOPE_TYPES.CATEGORY_WARD) {
    // Đúng một tỉnh: cặp (tỉnh, phường) là thứ duy nhất định danh được ô — xem `wardCodes`.
    if (this.provinceCodes.length !== 1) {
      return next(new Error('scope category_ward cần đúng một tỉnh trong provinceCodes'))
    }
    if (this.wardCodes.length === 0) {
      return next(new Error('scope category_ward cần ít nhất một phường'))
    }
    const province = this.provinceCodes[0]
    const stray = this.wardCodes.find((ward) => !isWardOfProvince(province, ward))
    if (stray) return next(new Error(`"${stray}" không thuộc ${province}`))
  } else if (this.wardCodes.length > 0) {
    return next(new Error('wardCodes chỉ có nghĩa với scope category_ward'))
  }
  next()
})

// Nạp grant của actor — chạy trên MỌI request cần phân quyền.
roleGrantSchema.index({ userId: 1, revokedAt: 1 })
// Đếm master còn hiệu lực (§5.4: luôn còn ít nhất một).
roleGrantSchema.index({ role: 1, revokedAt: 1 })
// Dashboard phủ sóng của master: ô (danh mục × tỉnh) nào chưa có người.
roleGrantSchema.index({ scopeType: 1, categoryId: 1, revokedAt: 1 })
// Cấp trùng một quyền hai lần là hai bản ghi cùng hiệu lực -> thu hồi một cái vẫn còn cái kia.
roleGrantSchema.index(
  { userId: 1, role: 1, scopeType: 1, orgId: 1, unitId: 1, categoryId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
)

export const RoleGrant: Model<IRoleGrantDocument> = mongoose.model<IRoleGrantDocument>(
  'RoleGrant',
  roleGrantSchema,
)
