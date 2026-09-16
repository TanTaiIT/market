import { Types } from 'mongoose'
import { CODE_PURPOSE } from './email-verification.model'
import { sendVerificationCode } from './email.sender'
import { consumeCode, dropCode, issueCode } from './verification-code.service'
import { userRepository } from '../user/user.repository'
import { ConflictError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

/**
 * Xác thực email bằng mã 6 số.
 *
 * Cả hai đường đều đòi ĐĂNG NHẬP và lấy người dùng từ token, không từ body. Nhận email trong
 * body sẽ dựng ra một máy dò: gửi thử từng địa chỉ, ai nhận 200 là có tài khoản. Đăng ký xong
 * client đã có token rồi (`register` trả luôn phiên), nên không mất gì.
 *
 * Khác hẳn `forgot-password`, nơi email BẮT BUỘC phải nằm trong body — và vì thế đường đó phải
 * trả 200 cho mọi địa chỉ. Hai luồng dùng chung `verification-code.service` nhưng ngược nhau ở
 * đúng điểm này.
 */
export interface SendCodeResult {
  /** Còn bao nhiêu giây nữa mã hết hạn — client đếm ngược bằng con số này. */
  expiresInSeconds: number
  /** Phải chờ bao lâu mới bấm gửi lại được. */
  resendAfterSeconds: number
}

export const emailVerificationService = {
  async sendCode(userId: string): Promise<SendCodeResult> {
    const user = await userRepository.findById(userId)
    if (!user) throw new NotFoundError('Không tìm thấy tài khoản')
    if (user.emailVerifiedAt) throw new ConflictError('Email này đã được xác thực')

    const issued = await issueCode(user._id, CODE_PURPOSE.VERIFY_EMAIL)
    try {
      await sendVerificationCode(user.email, issued.code)
    } catch (err) {
      await dropCode(user._id, CODE_PURPOSE.VERIFY_EMAIL)
      throw err
    }

    logger.info('verification code sent', { userId })
    return {
      expiresInSeconds: issued.expiresInSeconds,
      resendAfterSeconds: issued.resendAfterSeconds,
    }
  },

  async verify(userId: string, code: string): Promise<void> {
    await consumeCode(new Types.ObjectId(userId), CODE_PURPOSE.VERIFY_EMAIL, code)
    await userRepository.updateById(userId, { emailVerifiedAt: new Date() })
    logger.info('email verified', { userId })
  },
}
