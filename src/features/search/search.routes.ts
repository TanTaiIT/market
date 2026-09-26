import { Router } from 'express'
import { apiLimiter } from '../../middlewares/rateLimiter.middleware'
import { NotImplementedError } from '../../common/errors'

const router = Router()
// Trần chung theo IP/người dùng (audit 7.4) — mọi file routes phải có limiter, `routesLimiter.test` canh.
router.use(apiLimiter)

// TODO(search): tách search.service như 1 interface (MongoDB text index -> Elasticsearch/Algolia sau).
// Trước mắt listing.list đã hỗ trợ ?q= qua text index; module này để mở rộng gợi ý, facet, autocomplete.
router.use((_req, _res, next) => next(new NotImplementedError('search module chưa triển khai')))

export default router
