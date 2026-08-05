import { Router } from 'express'
import { userController } from './user.controller'
import { updateProfileSchema, userParamsSchema } from './user.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'

const router = Router()

router.get('/me', authenticate, userController.getMe)
router.patch('/me', authenticate, validate({ body: updateProfileSchema }), userController.updateMe)
router.delete('/me', authenticate, userController.deleteMe)

router.get('/:id', validate({ params: userParamsSchema }), userController.getById)

export default router
