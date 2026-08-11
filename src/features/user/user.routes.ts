import { z } from 'zod'
import { Router } from 'express'
import { userController } from './user.controller'
import {
  updateProfileSchema,
  userParamsSchema,
  publicProfileSchema,
  meProfileSchema,
} from './user.schema'
import { validate } from '../../middlewares/validate.middleware'
import { authenticate } from '../../middlewares/auth.middleware'
import { registry, bearerAuth, envelope, jsonResponse, errorResponse } from '../../config/openapi'

const router = Router()

router.get('/me', authenticate, userController.getMe)
router.patch('/me', authenticate, validate({ body: updateProfileSchema }), userController.updateMe)
router.delete('/me', authenticate, userController.deleteMe)

router.get('/:id', validate({ params: userParamsSchema }), userController.getById)

// ── OPENAPI ─────────────────────────────────────────────────────────────────
const protectedRoute = { security: [{ [bearerAuth.name]: [] }] }
const meResponse = envelope(meProfileSchema)

registry.registerPath({
  method: 'get',
  path: '/users/me',
  operationId: 'userGetMe',
  tags: ['User'],
  summary: 'Hồ sơ của chính mình',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Thông tin user hiện tại', meResponse),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'patch',
  path: '/users/me',
  operationId: 'userUpdateMe',
  tags: ['User'],
  summary: 'Cập nhật hồ sơ của chính mình',
  ...protectedRoute,
  request: { body: { content: { 'application/json': { schema: updateProfileSchema } } } },
  responses: {
    200: jsonResponse('Đã cập nhật', meResponse),
    400: errorResponse('Dữ liệu không hợp lệ'),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/users/me',
  operationId: 'userDeleteMe',
  tags: ['User'],
  summary: 'Xoá tài khoản (soft delete)',
  ...protectedRoute,
  responses: {
    200: jsonResponse('Đã xoá tài khoản', envelope(z.null())),
    401: errorResponse('Thiếu hoặc sai access token'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/users/{id}',
  operationId: 'userGetById',
  tags: ['User'],
  summary: 'Hồ sơ công khai của người bán',
  request: { params: userParamsSchema },
  responses: {
    200: jsonResponse('Hồ sơ công khai', envelope(publicProfileSchema)),
    404: errorResponse('Không tìm thấy user'),
  },
})

export default router
