import { Types } from 'mongoose'
import { KycProfile, IKycProfileDocument, KycStatus } from './kyc.model'
import { SubmitKycInput } from './kyc.schema'
import { userRepository } from '../user/user.repository'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

/** DTO chung — KHÔNG mang `idNumber`; nó chỉ đi theo đường duyệt của master. */
function toDto(doc: IKycProfileDocument) {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    subjectType: doc.subjectType,
    status: doc.status,
    fullName: doc.fullName,
    birthDate: doc.birthDate.toISOString().slice(0, 10),
    ...(doc.companyName ? { companyName: doc.companyName } : {}),
    ...(doc.companyAddress ? { companyAddress: doc.companyAddress } : {}),
    ...(doc.companyTaxCode ? { companyTaxCode: doc.companyTaxCode } : {}),
    rejectReason: doc.rejectReason,
    reviewedAt: doc.reviewedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  }
}

export const kycService = {
  /**
   * Nộp hồ sơ, hoặc nộp LẠI sau khi bị từ chối.
   *
   * Sửa chính bản ghi cũ chứ không đẻ bản mới: `userId` là unique, và lịch sử của một hồ sơ
   * nằm ở `reviewedAt`/`rejectReason` chứ không ở số dòng. Nộp lại đưa trạng thái về `pending`
   * và XOÁ lý do từ chối cũ — để nguyên là người nộp thấy lý do của bản trước trên bản mới.
   *
   * Hồ sơ đã DUYỆT thì khoá: đổi số định danh sau khi được duyệt là đi đường vòng qua đúng
   * bước duyệt. Muốn đổi thì master từ chối trước, rồi người dùng nộp lại.
   */
  async submit(userId: string, input: SubmitKycInput) {
    const existing = await KycProfile.findOne({ userId }).exec()
    if (existing?.status === 'approved') {
      throw new ConflictError('Hồ sơ đã được duyệt — liên hệ quản trị nếu cần sửa thông tin')
    }

    const doc = existing ?? new KycProfile({ userId: new Types.ObjectId(userId) })
    doc.subjectType = input.subjectType
    doc.fullName = input.fullName
    doc.birthDate = input.birthDate
    doc.idNumber = input.idNumber
    doc.companyName = input.subjectType === 'company' ? input.companyName : undefined
    doc.companyAddress = input.subjectType === 'company' ? input.companyAddress : undefined
    doc.companyTaxCode = input.subjectType === 'company' ? input.companyTaxCode : undefined
    doc.status = 'pending'
    doc.rejectReason = null
    doc.reviewedBy = null
    doc.reviewedAt = null

    // `enforceSubjectShape` của model chạy ở đây; lỗi hình dạng ra 400 qua `asShapeError`.
    await doc.save().catch(asShapeError)
    // KHÔNG log `idNumber` — dữ liệu định danh cá nhân không bao giờ vào log.
    logger.info('kyc submitted', { userId, subjectType: doc.subjectType })
    return toDto(doc)
  },

  /** Hồ sơ của chính mình. `null` = chưa nộp, và đó là một câu trả lời hợp lệ, không phải 404. */
  async mine(userId: string) {
    const doc = await KycProfile.findOne({ userId }).exec()
    return doc ? toDto(doc) : null
  },

  /** Bàn duyệt của master. Mặc định xem hàng CHỜ — đó là việc duy nhất cần làm ngay. */
  async list(query: { status?: KycStatus; page?: number; limit?: number }) {
    const limit = query.limit ?? 20
    const page = query.page ?? 1
    const filter = query.status ? { status: query.status } : {}
    const [docs, total] = await Promise.all([
      KycProfile.find(filter)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      KycProfile.countDocuments(filter),
    ])
    return { items: docs.map(toDto), total, page, limit }
  },

  /**
   * MỘT hồ sơ, kèm số định danh và danh tính tài khoản — bản master đọc lúc duyệt.
   *
   * `+idNumber` là chỗ DUY NHẤT trong cả module kéo field đó ra khỏi DB. Mọi đường khác dùng
   * `toDto`, vốn không có nó.
   */
  async detail(id: string) {
    const doc = await KycProfile.findById(id).select('+idNumber').exec()
    if (!doc) throw new NotFoundError('Không tìm thấy hồ sơ này')

    const user = await userRepository.findById(doc.userId.toString())
    return {
      ...toDto(doc),
      idNumber: doc.idNumber,
      accountName: user?.name ?? '(tài khoản không còn)',
      accountEmail: user?.email ?? '',
    }
  },

  async approve(actorId: string, id: string) {
    const doc = await setStatus(id, 'approved', actorId, null)
    logger.info('kyc approved', { actorId, kycId: id, userId: doc.userId.toString() })
    return toDto(doc)
  },

  async reject(actorId: string, id: string, reason: string) {
    const doc = await setStatus(id, 'rejected', actorId, reason)
    logger.info('kyc rejected', { actorId, kycId: id, userId: doc.userId.toString() })
    return toDto(doc)
  },
}

async function setStatus(id: string, status: KycStatus, actorId: string, reason: string | null) {
  const doc = await KycProfile.findById(id).exec()
  if (!doc) throw new NotFoundError('Không tìm thấy hồ sơ này')
  doc.status = status
  doc.rejectReason = reason
  doc.reviewedBy = new Types.ObjectId(actorId)
  doc.reviewedAt = new Date()
  await doc.save()
  return doc
}

/**
 * Lỗi hình dạng từ `enforceSubjectShape` → 400, không phải 500.
 *
 * Hook `pre('validate')` ném Error TRƠN, mà error handler chỉ nhận ra `mongoose.Error.*`. Nhận
 * diện bằng `constructor === Error` chứ không bằng chuỗi — cùng lý do đã ghi ở `role-grant`.
 */
function asShapeError(err: unknown): never {
  if (err instanceof Error && err.constructor === Error) throw new BadRequestError(err.message)
  throw err
}

/**
 * Tài khoản này đã qua duyệt chưa — câu hỏi DUY NHẤT phần còn lại của hệ thống hỏi module này.
 *
 * Giữ bề mặt ở đúng một hàm là điều làm cho lớp phủ này gỡ được: `kycGate` gọi nó, và không
 * chỗ nào khác import gì từ `kyc/`.
 */
export async function isKycApproved(userId: string): Promise<boolean> {
  const doc = await KycProfile.findOne({ userId }).select('status').lean().exec()
  return doc?.status === 'approved'
}
