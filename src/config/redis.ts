import Redis from 'ioredis'
import { env } from './env'
import { logger } from './logger'

let client: Redis | null = null

/**
 * Redis là optional. Không set REDIS_URL -> rate limit chạy in-memory và Socket.IO
 * dùng adapter in-memory, tức là CHỈ đúng khi chạy đúng 1 instance.
 */
export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null

  if (!client) {
    // maxRetriesPerRequest: null -> lệnh chờ reconnect thay vì reject; BullMQ cũng yêu cầu vậy.
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
    client.on('error', (err) => logger.error('Redis error', { err }))
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (!client) return
  await client.quit()
  client = null
}
