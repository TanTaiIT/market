import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../config/env'
import { ApiError } from '../../common/errors'
import { httpStatus } from '../../common/constants/httpStatus'
import { logger } from '../../config/logger'

/**
 * Gửi thư qua SMTP của Gmail — tầng DUY NHẤT trong repo biết tới nhà cung cấp thư.
 *
 * Service nghiệp vụ chỉ gọi `sendVerificationCode(to, code)`; đổi nhà cung cấp là sửa đúng
 * file này. Bản trước chạy Resend và đã đổi sang đây mà không phải đụng một dòng nào của
 * `emailVerificationService` — đó là lý do lớp này tồn tại.
 *
 * ## Vì sao Gmail chứ không phải một dịch vụ gửi thư
 *
 * Mọi dịch vụ gửi thư (Resend, SendGrid, SES…) đều bắt XÁC MINH MỘT TÊN MIỀN trước khi cho
 * gửi tới người ngoài — họ kiểm bằng bản ghi DNS, nên phải có tên miền và quyền vào DNS của
 * nó. Sản phẩm này là app thuần, không có tên miền nào. SMTP của Gmail là đường duy nhất còn
 * lại: thư đi từ chính hộp thư đã đăng nhập, nên không cần chứng minh quyền sở hữu gì thêm.
 *
 * ## Cái giá, biết trước để không ngạc nhiên
 *
 * - Google chặn quanh mốc **500 thư/ngày** cho tài khoản thường. Vượt là khoá gửi tạm thời,
 *   thường 24 giờ — và lúc đó KHÔNG ai đăng ký mới được.
 * - Người nhận thấy người gửi là địa chỉ Gmail cá nhân, không phải tên sàn.
 * - Không có SPF/DKIM của riêng mình nên tỉ lệ vào Spam cao hơn hẳn một tên miền đã xác minh.
 *
 * Đủ cho giai đoạn chạy thử và vài trăm người dùng đầu. Có tên miền rồi thì quay lại dịch vụ
 * gửi thư — lúc đó cũng chỉ sửa file này.
 */

/** Cache ở module scope: mỗi `createTransport` mở một pool kết nối riêng tới SMTP của Gmail. */
let transporter: Transporter | null = null

/** Thiếu một trong hai = tính năng TẮT. Kiểm tại chỗ dùng, không lúc khởi động: server vẫn phải chạy. */
export function mailEnabled(): boolean {
  return Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD)
}

/**
 * Địa chỉ người gửi ghép từ `GMAIL_USER`, KHÔNG phải một biến môi trường riêng.
 *
 * Gmail chỉ cho gửi từ chính tài khoản đã đăng nhập — khai một `MAIL_FROM` khác thì Gmail
 * lặng lẽ ghi đè lại, tức là một ô cấu hình chỉ có thể điền sai. Tên hiển thị là hằng số của
 * sản phẩm nên nó thuộc về code.
 */
const senderName = 'Ghim'

export async function sendVerificationCode(to: string, code: string): Promise<void> {
  if (!mailEnabled()) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Xác thực email chưa được bật trên máy chủ này',
    )
  }

  transporter ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  })

  try {
    await transporter.sendMail({
      from: `${senderName} <${env.GMAIL_USER}>`,
      to,
      subject: `${code} là mã xác thực Ghim của bạn`,
      text: codeText(code),
      html: codeHtml(code),
    })
  } catch (err) {
    /*
     * Ghi log NGUYÊN VĂN, nhưng chỉ chuyển ra ngoài ở môi trường dev.
     *
     * Ở production thông điệp của Gmail là bản đồ cấu hình máy chủ — nó nói rõ sai mật khẩu
     * ứng dụng, tài khoản chưa bật 2FA, hay đang bị khoá vì gửi quá nhiều. Người dùng thật
     * chỉ cần biết thư không đi được.
     *
     * Ở dev thì "người dùng" chính là người đang dựng hệ thống, và một câu mờ biến lỗi cấu
     * hình đọc-là-hiểu thành một buổi dò log. Đã xảy ra đúng một lần, hồi còn chạy Resend.
     */
    logger.error('gmail smtp send failed', { to, error: err })
    const detail = err instanceof Error ? err.message : String(err)
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      env.NODE_ENV === 'development'
        ? `Không gửi được thư: ${detail}`
        : 'Không gửi được thư, vui lòng thử lại',
    )
  }
}

/**
 * Bản `text` KHÔNG phải tuỳ chọn.
 *
 * Thư chỉ có HTML bị nhiều bộ lọc chấm điểm spam cao hơn hẳn, và mã xác thực mà rơi vào spam
 * thì tính năng coi như hỏng với đúng những người đang cần nó. Gửi qua Gmail cá nhân vốn đã
 * thiệt điểm vì không có SPF/DKIM riêng, nên đừng bỏ thêm điểm ở chỗ không cần bỏ.
 */
function codeText(code: string): string {
  return [
    `Mã xác thực của bạn là: ${code}`,
    '',
    'Mã có hiệu lực trong 10 phút và chỉ dùng được một lần.',
    'Nếu bạn không đăng ký tài khoản Ghim, hãy bỏ qua thư này.',
  ].join('\n')
}

/**
 * HTML nội tuyến, không template engine và không ảnh.
 *
 * Trình đọc thư không có `<style>` chung lẫn CSS ngoài, nên style phải nằm trên từng thẻ. Mã
 * để thành CHỮ chọn được, không phải ảnh: người dùng cần copy được nó, và ảnh thì phần lớn
 * hộp thư chặn mặc định.
 */
function codeHtml(code: string): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#17181C">
  <p style="font-size:15px;line-height:22px;margin:0 0 20px">Mã xác thực tài khoản Ghim của bạn:</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:0 0 20px;color:#16A05B">${code}</p>
  <p style="font-size:13px;line-height:19px;color:#6B7280;margin:0 0 8px">Mã có hiệu lực trong 10 phút và chỉ dùng được một lần.</p>
  <p style="font-size:13px;line-height:19px;color:#6B7280;margin:0">Nếu bạn không đăng ký tài khoản Ghim, hãy bỏ qua thư này.</p>
</div>`
}
