import mongoose from 'mongoose'
import { Agenda } from 'agenda'
import { MongoBackend } from '@agendajs/mongo-backend'
import type { Db } from 'mongodb'
import { env } from './env'
import { logger } from './logger'
import { machineReviewService } from '../features/moderation/moderation.machine.service'
import { listingExpiryService } from '../features/listing/listing.expiry.service'
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
    // Một sweep tại một thời điểm — hai sweep song song chấm trùng batch rồi thi nhau ghi.
    maxConcurrency: 1,
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
  if (cleanupConfigFromEnv()) {
    await agenda.every(env.IMAGE_CLEANUP_EVERY, JOBS.IMAGE_CLEANUP)
  }
  logger.info(
    `⏱️  Agenda started — machine review every ${env.MACHINE_REVIEW_EVERY}` +
      `, listing expiry every ${env.LISTING_EXPIRY_EVERY}` +
      (cleanupConfigFromEnv() ? `, image cleanup every ${env.IMAGE_CLEANUP_EVERY}` : ''),
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
