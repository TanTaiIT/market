import { Router } from 'express'
import { authController } from './auth.controller'
import { registerSchema, loginSchema, refreshSchema } from './auth.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authLimiter } from '../../middlewares/rateLimiter.middleware'

const router = Router()

// Rate limit chặt để chống brute-force
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login)
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh)

export default router
