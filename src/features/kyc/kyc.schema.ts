import { z } from 'zod'
import { registry } from '../../config/openapi'
import { KYC_STATUSES, KYC_SUBJECTS } from './kyc.model'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Số định danh: 9–12 CHỮ SỐ, chấp nhận cả CMND cũ lẫn CCCD 12 số.
 *
 * Không siết hơn (không kiểm mã tỉnh, không kiểm số kiểm tra): một luật chặt mà sai là người
 * dùng thật bị chặn ở cửa, còn Bộ thì vẫn đọc số trên giấy tờ để đối chiếu. Chốt hình dạng ở
 * đây chỉ để loại lỗi gõ, không phải để thay người duyệt.
 */
const idNumber = z
  .string()
  .trim()
  .regex(/^\d{9,12}$/, 'Số định danh phải là 9–12 chữ số')

/** Ngày sinh: ISO `YYYY-MM-DD`, phải ở quá khứ và người nộp từ 16 tuổi trở lên. */
const birthDate = z.coerce
  .date()
  .refine((d) => d < new Date(), 'Ngày sinh phải ở quá khứ')
  .refine(
    (d) => Date.now() - d.getTime() >= 16 * 365.25 * 24 * 60 * 60 * 1000,
    'Người nộp hồ sơ phải từ 16 tuổi',
  )

/**
 * Hai đối tượng, hai hình dạng — `discriminatedUnion` chứ không phải một object với đủ field
 * optional: cách sau cho phép gửi "cá nhân" kèm tên công ty, và không có chỗ nào từ chối nó.
 *
 * Ba trường cá nhân nằm ở CẢ HAI nhánh vì Bộ đòi vậy: với công ty thì chúng là của NGƯỜI ĐẠI
 * DIỆN THEO PHÁP LUẬT.
 */
export const submitKycSchema = z
  .discriminatedUnion('subjectType', [
    z.object({
      subjectType: z.literal(KYC_SUBJECTS[0]),
      fullName: z.string().trim().min(2).max(100),
      birthDate,
      idNumber,
    }),
    z.object({
      subjectType: z.literal(KYC_SUBJECTS[1]),
      companyName: z.string().trim().min(2).max(200),
      companyAddress: z.string().trim().min(5).max(300),
      /** Số định danh của TỔ CHỨC — mã số thuế/mã số doanh nghiệp. */
      companyTaxCode: z
        .string()
        .trim()
        .regex(/^\d{10}(-\d{3})?$/, 'Mã số doanh nghiệp gồm 10 số, chi nhánh thêm "-xxx"'),
      fullName: z.string().trim().min(2).max(100),
      birthDate,
      idNumber,
    }),
  ])
  .openapi('SubmitKyc')

export const rejectKycSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict()
  .openapi('RejectKyc')

export const kycParamsSchema = z.object({ id: objectId })

export const kycListQuerySchema = z.object({
  status: z.enum(KYC_STATUSES).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * DTO đọc. KHÔNG mang `idNumber` — số định danh chỉ ra khỏi DB qua đường duyệt của master
 * (`kycDetailSchema`), không bao giờ qua đường "xem trạng thái hồ sơ của tôi".
 */
export const kycProfileSchema = z
  .object({
    id: objectId,
    userId: objectId,
    subjectType: z.enum(KYC_SUBJECTS),
    status: z.enum(KYC_STATUSES),
    fullName: z.string(),
    birthDate: z.string(),
    companyName: z.string().optional(),
    companyAddress: z.string().optional(),
    companyTaxCode: z.string().optional(),
    rejectReason: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('KycProfile')

/** Bản master đọc lúc duyệt — thêm số định danh và danh tính tài khoản. */
export const kycDetailSchema = kycProfileSchema
  .extend({
    idNumber: z.string(),
    accountName: z.string(),
    accountEmail: z.string(),
  })
  .openapi('KycDetail')

export type SubmitKycInput = z.infer<typeof submitKycSchema>

registry.register('SubmitKyc', submitKycSchema)
registry.register('RejectKyc', rejectKycSchema)
registry.register('KycProfile', kycProfileSchema)
registry.register('KycDetail', kycDetailSchema)
