import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(search): tách search.service như 1 interface (MongoDB text index -> Elasticsearch/Algolia sau).
// Trước mắt listing.list đã hỗ trợ ?q= qua text index; module này để mở rộng gợi ý, facet, autocomplete.
router.use((_req, _res, next) => next(new NotImplementedError('search module chưa triển khai')))

export default router
