import { CODE_PURPOSE } from './email-verification.model'
import { sendPasswordResetCode } from './email.sender'
import { consumeCode, dropCode, issueCode, issueTicket } from './verification-code.service'
import { userRepository } from '../user/user.repository'
import { BadRequestError } from '../../common/errors'
import { logger } from '../../config/logger'

/**
 * Quên mật khẩu — mã 6 số về hộp thư, đổi lấy quyền đặt mật khẩu mới.
 *
 * ## Vì sao cả hai đường đều trả 200 cho email không tồn tại
 *
 * Email BẮT BUỘC nằm trong body: người quên mật khẩu thì theo định nghĩa là chưa đăng nhập
 * được, nên không có token để lấy danh tính ra. Hệ quả là endpoint này trả lời cho bất kỳ ai
 * gõ một địa chỉ vào — và nếu nó trả 404 cho địa chỉ lạ, 200 cho địa chỉ có thật, thì nó chính
 * là một máy dò tài khoản chạy bằng tiền của chúng ta.
 *
 * Nên **im lặng thành công** là hành vi đúng, không phải một lối tắt: không nhắn "email không
 * tồn tại", không nhắn "tài khoản bị khoá", không nhắn "tài khoản này đăng nhập bằng Google".
 * Ba câu đó đều là câu trả lời cho một câu hỏi kẻ tấn công đang hỏi.
 *
 * ## Vì sao đặt lại được cả tài khoản chỉ-Google
 *
 * `withGoogle` RÚT mật khẩu khi liên kết, nên một tài khoản Google có thể không có mật khẩu
 * nào. Đặt lại vẫn cho phép, vì bằng chứng ở hai đường là MỘT: gõ đúng mã trong hộp thư chứng
 * minh người này đang kiểm soát hộp thư ngay lúc này — đúng thứ Google chứng minh hộ. Từ chối
 * sẽ tạo một ngõ cụt thật: mất quyền vào tài khoản Google là mất luôn tài khoản ở đây, không
 * có đường nào lấy lại.
 *
 * Nó KHÔNG mở lại lỗ chiếm-tài-khoản-trước mà `withGoogle` bịt: kẻ tấn công vẫn phải đọc được
 * mã trong hộp thư nạn nhân, mà đọc được thì chúng đã thắng từ trước rồi.
 */
export const passwordResetService = {
  /**
   * Gửi mã đặt lại. Luôn resolve — người gọi không được biết chuyện gì đã xảy ra bên trong.
   *
   * Lỗi gửi thư cũng nuốt: phân biệt "gửi được" với "gửi hỏng" cũng là phân biệt "có tài khoản"
   * với "không", vì thư chỉ đi khi tài khoản tồn tại. Lỗi thật vẫn nằm trong log.
   */
  async requestReset(email: string): Promise<void> {
    const user = await userRepository.findByEmail(email)
    if (!user || !user.isActive) {
      logger.info('password reset requested for unusable account', { email })
      return
    }

    try {
      const issued = await issueCode(user._id, CODE_PURPOSE.RESET_PASSWORD)
      await sendPasswordResetCode(user.email, issued.code)
      logger.info('password reset code sent', { userId: user._id.toString() })
    } catch (err) {
      await dropCode(user._id, CODE_PURPOSE.RESET_PASSWORD)
      logger.error('password reset code failed', { email, error: err })
    }
  },

  /**
   * BƯỚC 2 — đổi mã lấy vé. Tách khỏi bước đặt mật khẩu vì trần 5 lần gõ sai:
   *
   * Gộp hai việc thì mỗi lần gõ nhầm mã bắt người dùng gõ lại cả mật khẩu — một ô họ không nhìn
   * thấy để soát — và mỗi lần gõ lại vẫn đốt một lượt trong năm lượt đó. Năm lần fat-finger là
   * mã chết, dù họ chưa hề sai ở phần mật khẩu.
   *
   * Vé đổi được dùng ĐÚNG MỘT LẦN và có đồng hồ 10 phút mới, nên bước 3 không phải mang lại mã.
   */
  async verifyCode(email: string, code: string): Promise<string> {
    const user = await userRepository.findByEmail(email)
    if (!user || !user.isActive) throw new BadRequestError('Mã không đúng hoặc đã hết hạn')

    await consumeCode(user._id, CODE_PURPOSE.RESET_PASSWORD, code)
    return issueTicket(user._id, CODE_PURPOSE.RESET_TICKET)
  },

  /**
   * BƯỚC 3 — đổi vé lấy mật khẩu mới.
   *
   * Ba việc phải xảy ra cùng nhau, và việc thứ ba là việc hay bị quên: `$inc tokenVersion` cắt
   * MỌI phiên đang mở. Người đi đặt lại mật khẩu thường đang nghi bị chiếm tài khoản — đổi mật
   * khẩu mà để phiên của kẻ kia sống tiếp 14 ngày thì chưa giải quyết được gì.
   *
   * Và đánh dấu email đã xác thực: gõ đúng mã chứng minh hộp thư, đúng bằng chứng mà luồng xác
   * thực email đòi. Bắt họ làm lại lần nữa là hỏi cùng một câu hai lần.
   */
  async resetPassword(email: string, ticket: string, newPassword: string): Promise<void> {
    // `withPassword` để `save()` bên dưới không phải ghi lên một path chưa nạp.
    const user = await userRepository.findByEmail(email, { withPassword: true })
    /*
     * Cùng CÂU và cùng LỚP LỖI với vé sai — `consumeCode` ném `BadRequestError`, nên nhánh này
     * cũng phải là 400. Ném 401 ở đây thì câu chữ giống nhau nhưng mã trạng thái khác, và một
     * máy dò chỉ cần đọc mã trạng thái: 401 = địa chỉ không có tài khoản, 400 = có.
     */
    if (!user || !user.isActive) throw new BadRequestError('Phiên đặt lại đã hết hạn')

    await consumeCode(user._id, CODE_PURPOSE.RESET_TICKET, ticket)

    // Gán rồi `save()` chứ không `updateById`: hook `pre('save')` của `user.model` mới là chỗ
    // hash mật khẩu — đường update đi thẳng xuống Mongo sẽ lưu mật khẩu dạng thô.
    user.password = newPassword
    user.emailVerifiedAt = user.emailVerifiedAt ?? new Date()
    user.tokenVersion += 1
    await user.save()

    logger.info('password reset', { userId: user._id.toString() })
  },
}
