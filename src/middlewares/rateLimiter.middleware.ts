import { Request, Response, NextFunction } from 'express'
import { RateLimiterMemory, RateLimiterRedis, RateLimiterAbstract } from 'rate-limiter-flexible'
import { getRedis } from '../config/redis'
import { TooManyRequestsError } from '../common/errors'

interface RateLimitConfig {
  keyPrefix: string
  points: number
  duration: number
}

/**
 * Tạo rate-limit middleware. Dùng Redis nếu có (chia sẻ nhiều instance),
 * fallback in-memory khi chạy local không có Redis.
 */
export function createRateLimiter({ keyPrefix, points, duration }: RateLimitConfig) {
  const redis = getRedis()
  const limiter: RateLimiterAbstract = redis
    ? new RateLimiterRedis({ storeClient: redis, keyPrefix, points, duration })
    : new RateLimiterMemory({ keyPrefix, points, duration })

  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const key = req.user?.id ?? req.ip ?? 'unknown'
      await limiter.consume(key)
      next()
    } catch {
      next(new TooManyRequestsError())
    }
  }
}

// Chặt cho auth (chống brute-force): 10 req / phút
export const authLimiter = createRateLimiter({ keyPrefix: 'rl:auth', points: 10, duration: 60 })
// Upload: 30 req / phút
export const uploadLimiter = createRateLimiter({ keyPrefix: 'rl:upload', points: 30, duration: 60 })
// API chung: 120 req / phút
export const apiLimiter = createRateLimiter({ keyPrefix: 'rl:api', points: 120, duration: 60 })
