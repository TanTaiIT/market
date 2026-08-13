import { Router } from 'express'
import { NotImplementedError } from '../../common/errors'

const router = Router()

// TODO(category): model dạng cây parent-child (Xe cộ > Ô tô > Sedan),
// CRUD danh mục, lấy cây danh mục, gán listing theo category.
router.use((_req, _res, next) => next(new NotImplementedError('category module chưa triển khai')))

export default router
