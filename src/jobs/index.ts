import { getRedis } from '../config/redis'
import { logger } from '../config/logger'

/**
 * Khởi tạo background jobs (BullMQ). Bỏ qua nếu không có Redis (dev không cần).
 * TODO: expire-listings (đổi status EXPIRED khi tới expiresAt), gửi email/notification.
 *
 * Lưu ý: listing.model đã có TTL index tự XOÁ document hết hạn. Nếu muốn "ẩn" thay vì
 * "xoá" (giữ lịch sử), bỏ TTL index và dùng job này để set status = EXPIRED.
 */
export async function initJobs(): Promise<void> {
  const redis = getRedis()
  if (!redis) {
    logger.warn('⏭️  Bỏ qua background jobs (không có REDIS_URL)')
    return
  }

  // const { Queue, Worker } = await import('bullmq');
  // const connection = redis;
  // new Worker('expire-listings', async () => { ... }, { connection });
  logger.info('✅ Jobs initialized')
}

/**
 * Drain/đóng BullMQ Worker & Queue khi shutdown (graceful).
 * TODO: gọi worker.close() / queue.close() khi đã triển khai job thật.
 */
export async function shutdownJobs(): Promise<void> {
  // Hiện chưa tạo worker/queue nên no-op.
}
