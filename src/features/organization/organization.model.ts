import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  ORG_TYPES,
  ORG_CAPABILITY_PRESETS,
  OrgCapabilities,
  OrgType,
  TENANT_STATUS,
  TenantStatus,
  VERIFICATION_TIERS,
  VerificationTier,
} from '../../common/constants'
import { normalizeOrgSlug, orgNameTokens } from '../../common/utils/orgSlug'

export interface IOrganization {
  name: string
  slug: string
  /** Khoá so trùng (bỏ dấu gạch, fold ký tự nhìn giống Latin) — chống mạo danh, không hiển thị. */
  slugNormalized: string
  /** Tên tách theo TỪ đã chuẩn hoá — khoá tra của dropdown, xem `orgNameTokens`. */
  nameTokens: string[]
  orgType: OrgType
  capabilities: OrgCapabilities
  verificationTier: VerificationTier
  /** Tên tỉnh trong danh sách đóng 34 đơn vị. `null` = org tổng quát không gắn địa bàn. */
  provinceCode: string | null
  district: string | null
  allowJoinRequests: boolean
  /** Mặc định TẮT: org nào không muốn nhận tin từ người ngoài thì slug đơn giản không hiện ra. */
  allowOutsiderPosts: boolean
  ownerId: Types.ObjectId
  /** Ai tạo org này. Chỉ master tạo được org (quyết định Q2), nên đây luôn là một master. */
  createdBy: Types.ObjectId | null
  status: TenantStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IOrganizationDocument extends IOrganization, Document {
  _id: Types.ObjectId
}

const capabilitiesSchema = new Schema<OrgCapabilities>(
  {
    hasUnits: { type: Boolean, default: false },
    hasAcademicYear: { type: Boolean, default: false },
  },
  { _id: false },
)

const organizationSchema = new Schema<IOrganizationDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    slugNormalized: { type: String, required: true, lowercase: true, trim: true },
    nameTokens: { type: [String], default: [] },

    orgType: { type: String, enum: Object.values(ORG_TYPES), default: ORG_TYPES.GENERIC },
    capabilities: {
      type: capabilitiesSchema,
      default: () => ORG_CAPABILITY_PRESETS[ORG_TYPES.GENERIC],
    },
    verificationTier: {
      type: String,
      enum: Object.values(VERIFICATION_TIERS),
      default: VERIFICATION_TIERS.UNVERIFIED,
    },

    provinceCode: { type: String, default: null, trim: true },
    district: { type: String, default: null, trim: true, maxlength: 100 },

    allowJoinRequests: { type: Boolean, default: true },
    allowOutsiderPosts: { type: Boolean, default: false },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    status: { type: String, enum: Object.values(TENANT_STATUS), default: TENANT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Dẫn xuất ở model chứ không ở service: slug đổi qua nhiều đường (tạo, đổi tên, migration) và
// một đường quên đồng bộ là khoá chống mạo danh im lặng lệch khỏi slug thật.
organizationSchema.pre('validate', function syncDerivedKeys(next) {
  if (this.slug && this.isModified('slug')) {
    this.slugNormalized = normalizeOrgSlug(this.slug)
  }
  // Cùng lý do, cho khoá tra của dropdown: tên đổi qua đường đổi tên lẫn migration, để service
  // tự nhớ đồng bộ là có ngày dropdown tìm theo tên cũ.
  if (this.name && this.isModified('name')) {
    this.nameTokens = orgNameTokens(this.name)
  }
  next()
})

// Organization *là* tenant nên KHÔNG gắn tenantPlugin — truy cập nó đi qua
// organization.repository (chạy runUnscoped), đó là nơi duy nhất được phép.
organizationSchema.index({ slug: 1 }, { unique: true })
// Unique thứ hai, không thừa: `slug` chặn trùng chính xác, `slugNormalized` chặn cả biến thể
// nhìn giống nhau (`abc-edu` vs `abcedu` vs `аbc-edu` viết bằng а Cyrillic).
organizationSchema.index({ slugNormalized: 1 }, { unique: true })

/*
 * Dropdown chọn org, nhánh tra theo TÊN. Multikey nên mỗi từ có bounds riêng: gõ "hung" là một
 * lượt tra tiền tố, không phải quét cả bảng.
 *
 * Thay cho hai index đã bỏ, cả hai đều chưa từng được query nào chạm tới:
 * `{ ownerId: 1 }` — `ownerId` chỉ được GHI lúc tạo org, không lọc, không authz (quyền đến từ
 *   `role_grants`), thậm chí không có trong DTO.
 * `{ provinceCode: 1, status: 1 }` — ghi chú cũ nói "dropdown lọc theo địa bàn", nhưng `search()`
 *   không hề lọc `provinceCode`; tham số cùng tên trên query string chỉ dùng để gợi ý slug.
 */
organizationSchema.index({ nameTokens: 1 })

export const Organization: Model<IOrganizationDocument> = mongoose.model<IOrganizationDocument>(
  'Organization',
  organizationSchema,
)

/**
 * Slug cũ → org, để URL đã phát ra ngoài không chết khi org đổi tên (§6.4).
 *
 * Nằm cùng file với Organization vì nó không có vòng đời riêng: mỗi bản ghi sinh ra đúng một
 * lần lúc đổi slug và không bao giờ được sửa. Bảng tra cứu định tuyến, không phải feature.
 */
export interface IOrgSlugAlias {
  oldSlug: string
  organizationId: Types.ObjectId
  createdAt: Date
}

export interface IOrgSlugAliasDocument extends IOrgSlugAlias, Document {
  _id: Types.ObjectId
}

const orgSlugAliasSchema = new Schema<IOrgSlugAliasDocument>(
  {
    oldSlug: { type: String, required: true, lowercase: true, trim: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// Một slug cũ chỉ trỏ về đúng một org — nếu không, redirect 301 thành xổ số.
orgSlugAliasSchema.index({ oldSlug: 1 }, { unique: true })

export const OrgSlugAlias: Model<IOrgSlugAliasDocument> = mongoose.model<IOrgSlugAliasDocument>(
  'OrgSlugAlias',
  orgSlugAliasSchema,
)
