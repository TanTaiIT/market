import Redis from 'ioredis'
import { env } from './env'
import { logger } from './logger'

let client: Redis | null = null

/**
 * Lazily tạo Redis client dùng chung. Trả về null khi không cấu hình REDIS_URL
 * để app vẫn chạy được ở local/dev mà không cần Redis.
 */
export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null
  if (client) return client

  client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 })
  client.on('connect', () => logger.info('✅ Redis connected'))
  client.on('error', (err) => logger.error({ err }, 'Redis error'))

  return client
}

/**
 * Đóng Redis client khi shutdown (graceful).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
