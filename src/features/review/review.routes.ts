import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(review): đánh giá người bán (rating 1-5 + comment) sau giao dịch;
// cập nhật denormalized ratingAvg/ratingCount trên User.
router.all('/*', (_req, _res, next) =>
  next(new NotImplementedError('review module chưa triển khai')),
)

export default router
