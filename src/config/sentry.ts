import * as Sentry from '@sentry/node'
import { env } from './env'
import { logger } from './logger'
import { currentRequestContext } from '../common/observability/requestContext'

/**
 * Nơi lỗi 5xx đi tới để KHÔNG bị mất.
 *
 * Vì sao cần thêm nó khi đã có log: log của một instance là một dòng chảy, không phải một danh
 * sách việc. Nó không gom nhóm (một lỗi xảy ra 400 lần trông như 400 sự việc), không đếm,
 * không giữ lâu trên free tier, và không đánh thức ai. Mà người dùng gặp lỗi 500 thì đa số
 * KHÔNG báo — họ chỉ rời đi. Không có chỗ này thì cách duy nhất biết prod đang lỗi là chờ một
 * người tử tế nhắn tin.
 *
 * TẮT HOÀN TOÀN khi thiếu `SENTRY_DSN` — cùng khuôn `cleanupConfigFromEnv` của job dọn ảnh:
 * thiếu env là tính năng chưa bật, không phải lỗi cấu hình. Nên dev và test không gửi gì đi
 * đâu, và không ai phải tạo tài khoản Sentry để chạy `npm test`.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    logger.info('Sentry chưa bật (thiếu SENTRY_DSN) — lỗi 5xx chỉ nằm trong log')
    return
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    /*
     * KHÔNG lấy mẫu trace: đây thuần là nơi nhận lỗi, không phải APM. Trace tự động của Sentry
     * đòi `init` chạy TRƯỚC khi require express/mongoose để vá được thư viện — mà `init` ở đây
     * chạy trong `bootstrap`, sau `createApp`. Bật `tracesSampleRate` mà không đổi thứ tự đó
     * chỉ tạo ra dữ liệu trace rỗng và một hoá đơn.
     */
    tracesSampleRate: 0,
    // Log đã có `requestId`; gửi kèm PII của người dùng sang bên thứ ba là một quyết định khác,
    // cần lý do riêng — mặc định là không.
    sendDefaultPii: false,
  })
  logger.info('Sentry đã bật', { environment: env.NODE_ENV })
}

/**
 * Báo một lỗi 5xx, kèm đúng thứ cần để tra lại: `requestId` nối sang log, route để gom nhóm.
 *
 * No-op khi Sentry chưa bật, nên call-site không phải kiểm điều kiện — `errorHandler` chỉ có
 * một nhánh cho cả hai môi trường.
 */
export function reportServerError(err: unknown, info: { method: string; route: string }): void {
  if (!Sentry.isInitialized()) return

  const ctx = currentRequestContext()
  Sentry.withScope((scope) => {
    // `requestId` là sợi chỉ duy nhất nối một sự việc ở Sentry với các dòng log của chính nó.
    if (ctx?.requestId) scope.setTag('requestId', ctx.requestId)
    if (ctx?.orgSlug) scope.setTag('orgSlug', ctx.orgSlug)
    if (ctx?.userId) scope.setUser({ id: ctx.userId })
    scope.setTag('method', info.method)
    scope.setTag('route', info.route)
    Sentry.captureException(err)
  })
}

/**
 * Đẩy hết phần còn trong bộ đệm trước khi process chết.
 *
 * Sentry gửi theo lô, nên không có bước này thì lỗi làm sập server — đúng loại lỗi cần nhất —
 * lại là lỗi duy nhất không bao giờ tới nơi.
 */
export async function flushSentry(): Promise<void> {
  if (!Sentry.isInitialized()) return
  await Sentry.flush(2000)
}
