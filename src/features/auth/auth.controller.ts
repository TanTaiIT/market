import { authService } from './auth.service'
import { toAuthResponseDto } from './auth.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const authController = {
  // POST /auth/register
  register: catchAsync(async (req, res) => {
    const result = await authService.register(req.body)
    created(res, { message: 'Organization created', data: toAuthResponseDto(result) })
  }),

  // POST /auth/login
  login: catchAsync(async (req, res) => {
    const result = await authService.login(req.body)
    success(res, { message: 'Logged in successfully', data: toAuthResponseDto(result) })
  }),

  // POST /auth/refresh
  refresh: catchAsync(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken)
    success(res, { message: 'Token refreshed', data: toAuthResponseDto(result) })
  }),
}
