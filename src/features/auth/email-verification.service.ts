import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/bcrypt'
import { Types } from 'mongoose'
import {
  CODE_TTL_MS,
  EmailVerification,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from './email-verification.model'
import { sendVerificationCode } from './email.sender'
import { userRepository } from '../user/user.repository'
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../../common/errors'
import { logger } from '../../config/logger'

/**
 * Xác thực email bằng mã 6 số.
 *
 * Cả hai đường đều đòi ĐĂNG NHẬP và lấy người dùng từ token, không từ body. Nhận email trong
 * body sẽ dựng ra một máy dò: gửi thử từng địa chỉ, ai nhận 200 là có tài khoản. Đăng ký xong
 * client đã có token rồi (`register` trả luôn phiên), nên không mất gì.
 *
 * Bcrypt rounds cố ý thấp hơn mật khẩu (xem `BCRYPT_ROUNDS` của `user.model`): mã sống 10 phút
 * và chỉ có 5 lượt đoán, nên chi phí phải trả cho mỗi lượt kiểm không cần bằng một mật khẩu
 * sống nhiều năm.
 */
const CODE_ROUNDS = 8

/** 6 chữ số từ CSPRNG. `Math.random` đoán được từ các giá trị trước — không dùng ở đây. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface SendCodeResult {
  /** Còn bao nhiêu giây nữa mã hết hạn — client đếm ngược bằng con số này. */
  expiresInSeconds: number
  /** Phải chờ bao lâu mới bấm gửi lại được. */
  resendAfterSeconds: number
}

export const emailVerificationService = {
  /**
   * Phát một mã mới và gửi đi. Mã cũ (nếu còn) bị GHI ĐÈ, không cộng thêm: một người dùng chỉ
   * có đúng một mã sống, nên bấm "gửi lại" là mã trong thư trước hết hiệu lực ngay.
   */
  async sendCode(userId: string): Promise<SendCodeResult> {
    const user = await userRepository.findById(userId)
    if (!user) throw new NotFoundError('Không tìm thấy tài khoản')
    if (user.emailVerifiedAt) throw new ConflictError('Email này đã được xác thực')

    const existing = await EmailVerification.findOne({ userId: user._id }).exec()
    if (existing) {
      const waited = Date.now() - existing.sentAt.getTime()
      if (waited < RESEND_COOLDOWN_MS) {
        throw new TooManyRequestsError(
          `Vui lòng chờ ${Math.ceil((RESEND_COOLDOWN_MS - waited) / 1000)} giây rồi gửi lại`,
        )
      }
    }

    const code = newCode()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS)

    // Ghi TRƯỚC rồi mới gửi, và xoá lại nếu gửi hỏng. Thứ tự ngược lại thì một lượt ghi hỏng
    // để người dùng cầm một mã không kiểm được, và họ không có cách nào biết điều đó.
    await EmailVerification.findOneAndUpdate(
      { userId: user._id },
      { codeHash: await hash(code, CODE_ROUNDS), expiresAt, attempts: 0, sentAt: now },
      { upsert: true, new: true },
    ).exec()

    try {
      await sendVerificationCode(user.email, code)
    } catch (err) {
      // Xoá để họ bấm gửi lại được NGAY, không phải chờ hết hạn chờ của một mã chưa từng tới.
      await EmailVerification.deleteOne({ userId: user._id }).exec()
      throw err
    }

    logger.info('verification code sent', { userId })
    return {
      expiresInSeconds: Math.floor(CODE_TTL_MS / 1000),
      resendAfterSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
    }
  },

  /**
   * Đổi mã lấy dấu đã xác thực.
   *
   * Mọi nhánh hỏng đều trả CÙNG MỘT câu "Mã không đúng hoặc đã hết hạn" — không phân biệt
   * "chưa gửi mã nào", "mã đã hết hạn" và "mã sai". Phân biệt ra là nói cho người đang dò
   * biết họ đang dò đúng hướng nào.
   */
  async verify(userId: string, code: string): Promise<void> {
    const wrong = () => new BadRequestError('Mã không đúng hoặc đã hết hạn')

    const row = await EmailVerification.findOne({ userId: new Types.ObjectId(userId) }).exec()
    // `expiresAt` so tay chứ không dựa TTL index: Mongo quét mỗi ~60 giây nên bản ghi hết hạn
    // vẫn đọc được một lúc — xem ghi chú ở chỗ khai index.
    if (!row || row.expiresAt.getTime() <= Date.now() || row.attempts >= MAX_ATTEMPTS) {
      throw wrong()
    }

    if (!(await verify(code, row.codeHash))) {
      const after = await EmailVerification.findOneAndUpdate(
        { _id: row._id },
        { $inc: { attempts: 1 } },
        { new: true },
      ).exec()
      // Chạm trần thì XOÁ, không để bản ghi chết nằm lại: người dùng bấm gửi lại là có mã mới
      // ngay, còn kẻ đang dò mất luôn mục tiêu.
      if (after && after.attempts >= MAX_ATTEMPTS) {
        await EmailVerification.deleteOne({ _id: row._id }).exec()
      }
      throw wrong()
    }

    await userRepository.updateById(userId, { emailVerifiedAt: new Date() })
    await EmailVerification.deleteOne({ _id: row._id }).exec()
    logger.info('email verified', { userId })
  },
}
