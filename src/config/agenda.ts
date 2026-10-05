import mongoose from 'mongoose'
import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import type { Db } from 'mongodb'
import { env } from './env'
import { logger } from './logger'
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
  /** Nhịp thường: chỉ lứa ảnh vừa chạm tuổi tối thiểu. Xem `SweepMode`. */
  IMAGE_CLEANUP: 'image-cleanup:sweep',
  /** Nhịp thưa: quét cả thư mục, vét rác phát sinh muộn mà nhịp trên không thể thấy. */
  IMAGE_CLEANUP_FULL: 'image-cleanup:full',
  LISTING_EXPIRY: 'listing-expiry:sweep',
  UNVERIFIED_CLEANUP: 'unverified-cleanup:sweep',
} as const

let agenda: Agenda | null = null

export async function startAgenda(): Promise<void> {
  // Dùng LẠI connection của Mongoose thay vì mở client thứ hai từ env.MONGO_URI: một pool duy
  // nhất, và test (vốn connect vào mongodb-memory-server SAU khi env đã đóng băng) trỏ đúng DB.
  const db = mongoose.connection.db
  if (!db) throw new Error('startAgenda phải chạy sau khi Mongo đã connect')

  agenda = new Agenda({
    // Cast qua Db của driver rời: mongoose bundle driver riêng nên hai bộ type không nhận nhau,
    // dù runtime là cùng một class.
    backend: new MongoBackend({ mongo: db as unknown as Db, collection: 'agendaJobs' }),
    processEvery: '30 seconds',
    /*
     * Trần TOÀN CỤC, không phải chốt chống trùng lặp. Chốt đó là `concurrency: 1` của TỪNG job
     * bên dưới.
     *
     * Trước đây chỗ này để `1` với lý do "một sweep tại một thời điểm". Lý do đúng nhưng công cụ
     * sai: `maxConcurrency` đếm MỌI job của instance, nên nó serialize cả những job chẳng liên
     * quan gì nhau. Chừng nào mỗi lượt quét còn vài giây thì không ai thấy; từ khi job dọn ảnh
     * có thể chạy nhiều phút (đọc trọn URL ảnh trong DB, cộng ngân sách quét 5 phút), nó chặn
     * luôn `machine-review` — job ĐƯA TIN LÊN BẢNG, chạy mỗi 2 phút. Người dùng chịu độ trễ đó.
     *
     * `5` = số job hiện có, tức trần này không còn xếp hàng ai nữa, chỉ còn là chặn trên phòng
     * khi danh sách job phình ra mà không ai để ý.
     */
    maxConcurrency: 5,
  })

  // lockLifetime dài hơn hẳn một lượt quét (batch 50, toàn query có index): process chết giữa
  // chừng thì lock tự nhả sau 5 phút, job không kẹt vĩnh viễn.
  agenda.define(
    JOBS.MACHINE_REVIEW,
    async () => {
      await machineReviewService.sweep()
    },
    { lockLifetime: 5 * 60 * 1000, concurrency: 1 },
  )

  // Thay cho TTL index đã bỏ trên `Listing.expiresAt` — xem ghi chú ở `listing.model.ts`.
  // `lockLifetime` ngắn hơn machine review: một `updateMany` đi trọn index, không có vòng lặp.
  agenda.define(
    JOBS.LISTING_EXPIRY,
    async () => {
      await listingExpiryService.sweep()
    },
    { lockLifetime: 2 * 60 * 1000, concurrency: 1 },
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
    { lockLifetime: 15 * 60 * 1000, concurrency: 1 },
  )

  // Chỉ đăng ký khi có đủ CLOUDINARY_* — thiếu là tính năng chưa bật, đừng chạy một job mà
  // lượt nào cũng bỏ qua rồi ghi log "thiếu env" mỗi ngày.
  if (cleanupConfigFromEnv()) {
    /*
     * `lockLifetime` phải TRÙM được cả ba pha, không chỉ pha quét.
     *
     * `CLEANUP.SCAN_BUDGET_MS` (5 phút) mới chỉ chặn pha quét; sau nó còn một lượt đọc toàn bộ
     * URL ảnh trong DB và một loạt lệnh xoá theo lô 100. Lock hết hạn giữa chừng là Agenda coi
     * lượt chạy đã chết và giao đúng việc đó cho một tiến trình thứ hai — hai lượt quét song
     * song trên cùng một kho ảnh, tốn gấp đôi hạn mức Admin API vốn đã là thứ phải tiết kiệm.
     *
     * 20 phút = 5 phút ngân sách quét + chỗ rộng cho hai pha sau. Nâng `SCAN_BUDGET_MS` thì
     * nâng con số này theo.
     */
    agenda.define(
      JOBS.IMAGE_CLEANUP,
      async () => {
        await uploadCleanupService.sweep(undefined, { mode: 'cohort' })
      },
      { lockLifetime: 20 * 60 * 1000, concurrency: 1 },
    )
    agenda.define(
      JOBS.IMAGE_CLEANUP_FULL,
      async () => {
        await uploadCleanupService.sweep(undefined, { mode: 'full' })
      },
      { lockLifetime: 20 * 60 * 1000, concurrency: 1 },
    )
  }

  await agenda.start()
  await agenda.every(env.MACHINE_REVIEW_EVERY, JOBS.MACHINE_REVIEW)
  await agenda.every(env.LISTING_EXPIRY_EVERY, JOBS.LISTING_EXPIRY)
  await agenda.every(env.UNVERIFIED_CLEANUP_EVERY, JOBS.UNVERIFIED_CLEANUP)
  if (cleanupConfigFromEnv()) {
    await agenda.every(env.IMAGE_CLEANUP_EVERY, JOBS.IMAGE_CLEANUP)
    await agenda.every(env.IMAGE_CLEANUP_FULL_EVERY, JOBS.IMAGE_CLEANUP_FULL)
  }
  logger.info(
    `⏱️  Agenda started — machine review every ${env.MACHINE_REVIEW_EVERY}` +
      `, listing expiry every ${env.LISTING_EXPIRY_EVERY}` +
      `, unverified cleanup every ${env.UNVERIFIED_CLEANUP_EVERY} (TTL ${env.UNVERIFIED_TTL_DAYS}d)` +
      (cleanupConfigFromEnv()
        ? `, image cleanup every ${env.IMAGE_CLEANUP_EVERY} (lứa) + ${env.IMAGE_CLEANUP_FULL_EVERY} (toàn kho)`
        : ''),
  )
}

export async function stopAgenda(): Promise<void> {
  if (!agenda) return
  // `stop` nhả lock của job đang chạy để lần boot sau nhận việc ngay, không chờ lockLifetime.
  // Không có client riêng để đóng — connection là của Mongoose, `disconnectDB` lo phần đó
  // (server.ts gọi stopAgenda TRƯỚC disconnectDB, đúng thứ tự phụ thuộc).
  await agenda.stop()
  agenda = null
}
