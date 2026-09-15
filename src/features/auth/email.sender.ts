import { Resend } from 'resend'
import { env } from '../../config/env'
import { ApiError } from '../../common/errors'
import { httpStatus } from '../../common/constants/httpStatus'
import { logger } from '../../config/logger'

/**
 * Gửi thư qua Resend — tầng DUY NHẤT trong repo biết tới nhà cung cấp thư.
 *
 * Tách khỏi service nghiệp vụ để đổi nhà cung cấp là sửa một file: `emailVerificationService`
 * chỉ gọi `sendVerificationCode`, không biết Resend tồn tại.
 */

/** Cache ở module scope, cùng lý do `google.verify`: dựng client mới mỗi request là lãng phí. */
let client: Resend | null = null

/** Rỗng = tính năng TẮT. Kiểm tại chỗ dùng chứ không lúc khởi động: server vẫn phải chạy được. */
export function mailEnabled(): boolean {
  return Boolean(env.RESEND_API_KEY)
}

export async function sendVerificationCode(to: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Xác thực email chưa được bật trên máy chủ này',
    )
  }

  client ??= new Resend(env.RESEND_API_KEY)

  const { error } = await client.emails.send({
    from: env.MAIL_FROM,
    to,
    subject: `${code} là mã xác thực Ghim của bạn`,
    text: codeText(code),
    html: codeHtml(code),
  })

  if (error) {
    /*
     * Ghi log NGUYÊN VĂN lỗi của Resend nhưng KHÔNG chuyển nó ra ngoài: thông điệp của họ nói
     * rõ tên miền chưa xác minh, khoá sai, hay địa chỉ bị chặn — ba thứ là bản đồ cấu hình máy
     * chủ. Người dùng chỉ cần biết thư không đi được và bấm gửi lại.
     */
    logger.error('resend send failed', { to, error })
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Không gửi được thư, vui lòng thử lại')
  }
}

/**
 * Bản `text` KHÔNG phải tuỳ chọn.
 *
 * Thư chỉ có HTML bị nhiều bộ lọc chấm điểm spam cao hơn hẳn, và mã xác thực mà rơi vào spam
 * thì tính năng coi như hỏng với đúng những người đang cần nó.
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
