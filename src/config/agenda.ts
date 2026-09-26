import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import { env } from './env'
import { logger } from './logger'
import { reportJobError } from './sentry'
import { machineReviewService } from '../features/moderation/moderation.machine.service'
import { listingExpiryService } from '../features/listing/listing.expiry.service'
import { unverifiedCleanupService } from '../features/auth/unverified-cleanup.service'
import {
  cleanupConfigFromEnv,
  uploadCleanupService,
} from '../features/upload/upload.cleanup.service'

/**
 * Scheduler nền — Agenda chạy trên chính Mongo (collection `agendaJobs`), không thêm hạ tầng.
 *
 * Lịch job nằm trong DB nên instance ngủ (Render free tier spin-down) không làm mất lượt chạy:
 * lần chạy quá hạn được xử ngay khi process thức dậy. Nghĩa là trên free tier, job chỉ chạy khi
 * CÓ traffic đánh thức server — muốn đều tuyệt đối thì thêm một cron ping bên ngoài hoặc nâng
 * instance, không phải sửa code ở đây.
 *
 * Chỉ `server.ts` gọi start — test import app mà không kéo scheduler dậy, sweep được test bằng
 * cách gọi thẳng `machineReviewService.sweep()`.
 */
const JOBS = {
  MACHINE_REVIEW: 'machine-review:sweep',
  IMAGE_CLEANUP: 'image-cleanup:sweep',
  LISTING_EXPIRY: 'listing-expiry:sweep',
  UNVERIFIED_CLEANUP: 'unverified-cleanup:sweep',
} as const

let agenda: Agenda | null = null

/**
 * `address` có tham số vì test trỏ vào mongodb-memory-server, mà `env` đã đóng băng trước khi
 * server ảo có URI. Server thật không truyền gì.
 */
export async function startAgenda(address: string = env.MONGO_URI): Promise<void> {
  agenda = new Agenda({
    /*
     * Kết nối RIÊNG bằng driver của chính backend — KHÔNG mượn `mongoose.connection.db`.
     *
     * Bản trước dùng chung để có "một pool duy nhất", với giả định hai bộ type chỉ khác nhau
     * trên giấy còn runtime là cùng một class. Giả định đó sai: mongoose đóng gói `mongodb@6`
     * (bson 6) trong `node_modules` riêng của nó, còn `@agendajs/mongo-backend` kéo `mongodb@7`
     * (bson 7). Agenda tạo ObjectId bằng bson 7 rồi ghi qua driver của mongoose, bson 6 từ chối:
     * `BSONVersionError` ở MỌI lượt quét hàng đợi, 30 giây một lần — tức không job nào từng
     * chạy, và không ai thấy vì trước đây không có listener `error`. Hai pool nhỏ rẻ hơn hẳn
     * một scheduler chết im.
     *
     * Muốn quay lại một pool thì phải khai `mongodb` ở gốc `package.json` đúng bản mongoose
     * dùng để npm dedupe — đó là thay đổi package, không phải thay đổi ở đây.
     */
    backend: new MongoBackend({ address, collection: 'agendaJobs' }),
    processEvery: '30 seconds',
    // Một sweep tại một thời điểm — hai sweep song song chấm trùng batch rồi thi nhau ghi.
    maxConcurrency: 1,
  })

  /*
   * Job hỏng phải LÊN TIẾNG. Agenda nuốt lỗi của handler vào `attrs.failReason` rồi đi tiếp;
   * không ai nghe `fail` thì `listing-expiry:sweep` chết mỗi giờ mà tin quá hạn vẫn ACTIVE, và
   * Sentry chỉ biết lỗi HTTP (`errorHandler`) — job chạy ngoài mọi request.
   */
  agenda.on('fail', (err: Error, job: { attrs: { name: string } }) => {
    logger.error('agenda job failed', { job: job.attrs.name, err })
    reportJobError(err, job.attrs.name)
  })
  agenda.on('error', (err: Error) => {
    logger.error('agenda backend error', { err })
    reportJobError(err, 'agenda')
  })

  // lockLifetime dài hơn hẳn một lượt quét (batch 50, toàn query có index): process chết giữa
  // chừng thì lock tự nhả sau 5 phút, job không kẹt vĩnh viễn.
  agenda.define(
    JOBS.MACHINE_REVIEW,
    async () => {
      await machineReviewService.sweep()
    },
    { lockLifetime: 5 * 60 * 1000 },
  )

  // Thay cho TTL index đã bỏ trên `Listing.expiresAt` — xem ghi chú ở `listing.model.ts`.
  // `lockLifetime` ngắn hơn machine review: một `updateMany` đi trọn index, không có vòng lặp.
  agenda.define(
    JOBS.LISTING_EXPIRY,
    async () => {
      await listingExpiryService.sweep()
    },
    { lockLifetime: 2 * 60 * 1000 },
  )

  /*
   * Dọn tài khoản đăng ký rồi bỏ, quá hạn xác thực email.
   *
   * `lockLifetime` rộng nhất trong ba job đầu: nó XOÁ, và mỗi ứng viên tốn ba phép đếm để chắc
   * tài khoản thật sự trống (`hasAnything`). Một mẻ 200 người vì thế chạy lâu hơn hẳn một
   * `updateMany` đi trọn index — lock hết hạn giữa chừng là hai instance cùng xoá một mẻ.
   */
  agenda.define(
    JOBS.UNVERIFIED_CLEANUP,
    async () => {
      await unverifiedCleanupService.sweep()
    },
    { lockLifetime: 15 * 60 * 1000 },
  )

  // Chỉ đăng ký khi có đủ CLOUDINARY_* — thiếu là tính năng chưa bật, đừng chạy một job mà
  // lượt nào cũng bỏ qua rồi ghi log "thiếu env" mỗi ngày.
  if (cleanupConfigFromEnv()) {
    agenda.define(
      JOBS.IMAGE_CLEANUP,
      async () => {
        await uploadCleanupService.sweep()
      },
      { lockLifetime: 10 * 60 * 1000 },
    )
  }

  await agenda.start()
  await agenda.every(env.MACHINE_REVIEW_EVERY, JOBS.MACHINE_REVIEW)
  await agenda.every(env.LISTING_EXPIRY_EVERY, JOBS.LISTING_EXPIRY)
  await agenda.every(env.UNVERIFIED_CLEANUP_EVERY, JOBS.UNVERIFIED_CLEANUP)
  if (cleanupConfigFromEnv()) {
    await agenda.every(env.IMAGE_CLEANUP_EVERY, JOBS.IMAGE_CLEANUP)
  }
  logger.info(
    `⏱️  Agenda started — machine review every ${env.MACHINE_REVIEW_EVERY}` +
      `, listing expiry every ${env.LISTING_EXPIRY_EVERY}` +
      `, unverified cleanup every ${env.UNVERIFIED_CLEANUP_EVERY} (TTL ${env.UNVERIFIED_TTL_DAYS}d)` +
      (cleanupConfigFromEnv() ? `, image cleanup every ${env.IMAGE_CLEANUP_EVERY}` : ''),
  )
}

export async function stopAgenda(): Promise<void> {
  if (!agenda) return
  // `stop` nhả lock của job đang chạy để lần boot sau nhận việc ngay, không chờ lockLifetime.
  // `true` = đóng luôn client riêng của backend (xem `startAgenda`) — không còn mượn connection
  // của Mongoose, nên `disconnectDB` không đóng hộ được nữa.
  await agenda.stop(true)
  agenda = null
}
