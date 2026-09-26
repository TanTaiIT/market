import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import {
  FEED_LAYOUTS,
  FeedLayout,
  ORG_TYPES,
  ORG_CAPABILITY_PRESETS,
  OrgCapabilities,
  OrgType,
  TENANT_STATUS,
  TenantStatus,
  VERIFICATION_TIERS,
  VerificationTier,
} from '../../common/constants'
import { orgNameTokens } from '../../common/utils/orgName'

export interface IOrganization {
  name: string
  /** Tên tách theo TỪ đã chuẩn hoá — khoá tra của dropdown, xem `orgNameTokens`. */
  nameTokens: string[]
  orgType: OrgType
  capabilities: OrgCapabilities
  verificationTier: VerificationTier
  /** Tên tỉnh trong danh sách đóng 34 đơn vị. `null` = org tổng quát không gắn địa bàn. */
  provinceCode: string | null
  district: string | null
  /**
   * Hồ sơ nhóm — thứ người ngoài nhìn thấy khi mở link chia sẻ.
   *
   * Ảnh là URL Cloudinary do CLIENT upload thẳng lên (unsigned preset), BE chỉ nhận đường dẫn.
   * Cùng đường mà ảnh tin đăng đang đi: không có file nào chạy qua server này.
   */
  /**
   * Mã để xin gia nhập. Đổi được — rò mã thì xoay mã; `_id` của org (định danh trong mọi link
   * đã phát ra ngoài) thì không bao giờ đổi. Xem `common/utils/joinCode.ts`.
   */
  joinCode: string
  avatarUrl: string | null
  coverUrl: string | null
  description: string
  /**
   * Nhóm có được LIỆT KÊ và xin vào tự do không.
   *
   * `true` (mặc định): hiện ở gợi ý, mở được hồ sơ theo id, bấm là gửi đơn — không cần mã.
   * `false`: không xuất hiện ở bất kỳ danh sách công khai nào, chỉ vào được bằng `joinCode`.
   *
   * Tách khỏi `allowJoinRequests` vì hai câu hỏi khác nhau: cái này là "ai TÌM THẤY nhóm",
   * cái kia là "nhóm còn NHẬN đơn không". Một nhóm công khai vẫn có thể tạm đóng cửa nhận
   * đơn giữa mùa nhập học mà không phải biến mất khỏi kết quả tìm.
   */
  isPublic: boolean
  /** Nội quy nhóm, do admin nhóm tự soạn. Hiện trên hồ sơ nhóm cho người chưa vào đọc trước. */
  rules: string[]
  /** Bảng tin bày một tin một dòng hay hai tin một dòng — xem `FEED_LAYOUTS`. */
  feedLayout: FeedLayout
  allowJoinRequests: boolean
  /**
   * Nhóm có nhận tin từ người KHÔNG phải thành viên không.
   *
   * Mặc định BẬT (đổi 2026-08-23): gửi tin vào một nhóm không còn đòi phải gia nhập trước.
   * Tin của người ngoài đi hàng đợi riêng (`pending_unverified`) và KHÔNG bao giờ tự đăng,
   * dù người gửi uy tín tới đâu — quản trị nhóm luôn là người quyết cuối.
   * Nhóm kín (trường học, nội bộ công ty) tự tắt qua `PATCH /organizations/current`.
   */
  allowOutsiderPosts: boolean
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

    joinCode: { type: String, required: true, uppercase: true, trim: true },
    avatarUrl: { type: String, default: null },
    coverUrl: { type: String, default: null },
    description: { type: String, default: '', trim: true, maxlength: 500 },

    isPublic: { type: Boolean, default: true },
    rules: { type: [String], default: [] },
    feedLayout: {
      type: String,
      enum: Object.values(FEED_LAYOUTS),
      default: FEED_LAYOUTS.FEED,
    },
    allowJoinRequests: { type: Boolean, default: true },
    allowOutsiderPosts: { type: Boolean, default: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    status: { type: String, enum: Object.values(TENANT_STATUS), default: TENANT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Dẫn xuất ở model chứ không ở service: tên đổi qua nhiều đường (tạo, đổi tên, migration), để
// service tự nhớ đồng bộ là có ngày ô tìm nhóm tra theo tên cũ.
organizationSchema.pre('validate', function syncDerivedKeys(next) {
  if (this.name && this.isModified('name')) {
    this.nameTokens = orgNameTokens(this.name)
  }
  next()
})

/*
 * Soft delete — cùng hook với mọi model có `deletedAt` khác (User, Listing, OrgUnit…).
 *
 * Model này từng là ngoại lệ duy nhất: repository tự viết `deletedAt: null` ở từng query, và
 * method mới nhất (`allImageUrls`) đã quên — job dọn ảnh vì thế giữ ảnh của org đã xoá như
 * đang được dùng. Hook ở model là chỗ duy nhất không ai phải nhớ. `withDeleted` cho đường cần
 * đọc cả bản đã xoá (không có caller nào hôm nay, giữ cùng hợp đồng với các model kia).
 */
function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}
organizationSchema.pre(/^find/, excludeDeleted)
organizationSchema.pre('countDocuments', excludeDeleted)

// Organization *là* tenant nên KHÔNG gắn tenantPlugin — truy cập nó đi qua
// organization.repository (chạy runUnscoped), đó là nơi duy nhất được phép.
/*
 * Ô tìm nhóm, tra theo TÊN. Multikey nên mỗi từ có bounds riêng: gõ "hung" là một lượt tra
 * tiền tố, không phải quét cả bảng. Định danh của org là `_id` — không có khoá chữ nào khác.
 */
organizationSchema.index({ nameTokens: 1 })
// Đường tra của ô "tìm nhóm" và của mọi đơn xin gia nhập. Unique để hai org không bao giờ
// chung một mã — chính index này là trọng tài khi hai lượt sinh mã đụng nhau.
organizationSchema.index({ joinCode: 1 }, { unique: true })

export const Organization: Model<IOrganizationDocument> = mongoose.model<IOrganizationDocument>(
  'Organization',
  organizationSchema,
)
