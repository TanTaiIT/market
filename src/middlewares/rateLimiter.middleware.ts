import { Request, Response, NextFunction } from 'express'
import { RateLimiterMemory, RateLimiterRedis, RateLimiterAbstract } from 'rate-limiter-flexible'
import { getRedis } from '../config/redis'
import { env } from '../config/env'
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
    // Test chạy hàng chục request từ CÙNG một IP trong vài giây, mà `authLimiter` khoá theo IP
    // (lúc đăng ký chưa có user). Không bỏ qua thì mỗi file test lại 429 theo thứ tự chạy —
    // một chốt hạ tầng biến thành nguồn flake của toàn bộ suite nghiệp vụ.
    if (env.isTest) return next()

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
/**
 * Tra cứu org: 20 req / phút. Đây là API CÔNG KHAI, chưa cần đăng nhập — không chặn thì nó là
 * công cụ dò toàn bộ danh sách khách hàng, mỗi lần một ký tự. Chặt hơn `apiLimiter` vì người
 * dùng thật chỉ gõ vài lần cho một ô autocomplete.
 */
export const lookupLimiter = createRateLimiter({ keyPrefix: 'rl:lookup', points: 20, duration: 60 })
