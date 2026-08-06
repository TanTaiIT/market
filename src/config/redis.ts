// Redis connection temporarily disabled.
// If you want to re-enable Redis, restore the original implementation
// which used `ioredis` and `env.REDIS_URL`.

import type { Redis } from 'ioredis'

/**
 * Redis is currently disabled at runtime, but we keep the API and
 * type signatures so other modules can still import `getRedis()` and
 * safely handle a `null` return value.
 */
export function getRedis(): Redis | null {
  // if (env.REDIS_URL) {
  //   logger.warn('REDIS_URL is set but Redis client is disabled in source')
  // }
  return null
}

/**
 * No-op close function to keep shutdown flow intact.
 */
export async function closeRedis(): Promise<void> {
  return
}
