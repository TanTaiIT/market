import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * HỒ SƠ ĐỊNH DANH NGƯỜI BÁN — yêu cầu tuân thủ của Bộ Công Thương.
 *
 * ĐÂY LÀ MỘT LỚP PHỦ, KHÔNG PHẢI MỘT PHẦN CỦA HỆ THỐNG. Toàn bộ tính năng sống trong
 * `src/features/kyc/`, và nó chạm vào phần còn lại đúng BA chỗ:
 *
 * 1. `config/env.ts`   — cờ `KYC_REQUIRED`, mặc định TẮT;
 * 2. `features/index.ts` — một dòng `router.use(kycGate)`;
 * 3. (không có chỗ thứ ba — cố ý).
 *
 * Gỡ về sau = xoá thư mục này, xoá hai dòng trên, drop collection `kycprofiles`. KHÔNG
 * migration, KHÔNG đụng dữ liệu lõi — vì không một field nào của KYC chảy vào `User` hay
 * `Listing`. Đó là lý do nó là bảng PHỤ khoá theo `userId`, đúng khuôn `UserTrust`, chứ không
 * phải vài cột thêm vào `User`.
 *
 * DỮ LIỆU ĐỊNH DANH CÁ NHÂN. `idNumber` (CCCD) và `repIdNumber` mang `select: false`: chúng chỉ
 * ra khỏi DB khi có người hỏi đích danh, nên một lượt `find()` quên `.select()` không thể vô
 * tình đẩy chúng vào response hay vào log. KHÔNG đánh index trên chúng — index là một bản sao
 * thứ hai của cùng dữ liệu, nằm ngoài tầm `select: false`.
 */

export const KYC_SUBJECTS = ['individual', 'company'] as const
export type KycSubject = (typeof KYC_SUBJECTS)[number]

export const KYC_STATUSES = ['pending', 'approved', 'rejected'] as const
export type KycStatus = (typeof KYC_STATUSES)[number]

export interface IKycProfile {
  userId: Types.ObjectId
  subjectType: KycSubject
  status: KycStatus

  /** Cá nhân, và cũng là NGƯỜI ĐẠI DIỆN của công ty — Bộ đòi cùng ba trường cho cả hai. */
  fullName: string
  birthDate: Date
  idNumber: string

  /** Chỉ `company`. Hình dạng do `enforceSubjectShape` canh, không phải `required` của schema. */
  companyName?: string
  companyAddress?: string
  companyTaxCode?: string

  reviewedBy: Types.ObjectId | null
  reviewedAt: Date | null
  /** Lý do từ chối — người nộp đọc được để sửa và nộp lại. */
  rejectReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface IKycProfileDocument extends IKycProfile, Document {
  _id: Types.ObjectId
}

const kycProfileSchema = new Schema<IKycProfileDocument>(
  {
    // `unique`: một người một hồ sơ. Nộp lại sau khi bị từ chối là SỬA chính bản ghi đó, không
    // đẻ bản mới — lịch sử nằm ở `reviewedAt`/`rejectReason`, không ở số dòng.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    subjectType: { type: String, enum: KYC_SUBJECTS, required: true },
    status: { type: String, enum: KYC_STATUSES, default: 'pending', index: true },

    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    birthDate: { type: Date, required: true },
    idNumber: { type: String, required: true, trim: true, maxlength: 20, select: false },

    companyName: { type: String, trim: true, maxlength: 200 },
    companyAddress: { type: String, trim: true, maxlength: 300 },
    companyTaxCode: { type: String, trim: true, maxlength: 20 },

    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true },
)

/**
 * Công ty phải đủ ba trường doanh nghiệp; cá nhân phải KHÔNG mang trường nào trong số đó.
 *
 * Canh ở model chứ không chỉ ở zod, cùng lý do `role-grant` làm vậy: zod gác cửa HTTP, còn
 * model gác mọi đường ghi kể cả seed và script. Một hồ sơ "cá nhân" mà dính `companyTaxCode`
 * là hồ sơ không giải thích được cho người đi duyệt.
 */
kycProfileSchema.pre('validate', function enforceSubjectShape(next) {
  const companyFields = ['companyName', 'companyAddress', 'companyTaxCode'] as const
  if (this.subjectType === 'company') {
    const missing = companyFields.find((f) => !this.get(f))
    if (missing) return next(new Error(`Hồ sơ công ty thiếu ${missing}`))
  } else {
    const stray = companyFields.find((f) => this.get(f))
    if (stray) return next(new Error(`Hồ sơ cá nhân không mang ${stray}`))
  }
  next()
})

export const KycProfile: Model<IKycProfileDocument> = mongoose.model<IKycProfileDocument>(
  'KycProfile',
  kycProfileSchema,
)
