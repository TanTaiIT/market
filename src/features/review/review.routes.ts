import { Router } from 'express'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import { NotImplementedError } from '../../common/errors'

const router = Router()
// Trần chung theo IP/người dùng (audit 7.4) — mọi file routes phải có limiter, `routesLimiter.test` canh.
router.use(apiLimiter)

// TODO(review): đánh giá người bán (rating 1-5 + comment) sau giao dịch;
// cập nhật denormalized ratingAvg/ratingCount trên User.
router.use((_req, _res, next) => next(new NotImplementedError('review module chưa triển khai')))

export default router
