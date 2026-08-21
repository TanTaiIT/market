import { Request, Response, NextFunction } from 'express'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import { env } from '../config/env'
import { TooManyRequestsError } from '../common/errors'

interface RateLimitConfig {
  keyPrefix: string
  points: number
  duration: number
}

/**
 * Tạo rate-limit middleware, đếm TRONG BỘ NHỚ của process.
 *
 * Hệ quả cần biết trước khi scale: chạy N instance thì mỗi instance giữ bộ đếm riêng, nên trần
 * thật là N × `points`. Đúng ở quy mô một instance hiện tại. Muốn đếm chung thì
 * `rate-limiter-flexible` có sẵn `RateLimiterRedis` — đổi đúng dòng khởi tạo bên dưới, không
 * phải sửa gì khác.
 */
export function createRateLimiter({ keyPrefix, points, duration }: RateLimitConfig) {
  const limiter = new RateLimiterMemory({ keyPrefix, points, duration })

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
// API chung: 120 req / phút
export const apiLimiter = createRateLimiter({ keyPrefix: 'rl:api', points: 120, duration: 60 })
/**
 * Tra cứu org: 20 req / phút. Đây là API CÔNG KHAI, chưa cần đăng nhập — không chặn thì nó là
 * công cụ dò toàn bộ danh sách khách hàng, mỗi lần một ký tự. Chặt hơn `apiLimiter` vì người
 * dùng thật chỉ gõ vài lần cho một ô autocomplete.
 */
export const lookupLimiter = createRateLimiter({ keyPrefix: 'rl:lookup', points: 20, duration: 60 })
