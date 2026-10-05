import { Router } from 'express'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import { NotImplementedError } from '../../common/errors'

const router = Router()
// Trần chung theo IP/người dùng (audit 7.4) — mọi file routes phải có limiter, `routesLimiter.test` canh.
router.use(apiLimiter)

// TODO(search): text index đã bỏ (vỡ với scope nhiều org). Bảng tin lọc `?q=` bằng regex trên
// `title`; đường này chờ Atlas Search — xem audit §8.
// Trước mắt listing.list đã hỗ trợ ?q= qua text index; module này để mở rộng gợi ý, facet, autocomplete.
router.use((_req, _res, next) => next(new NotImplementedError('search module chưa triển khai')))

export default router
