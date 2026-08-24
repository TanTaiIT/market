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

  // POST /auth/bootstrap-master
  bootstrapMaster: catchAsync(async (req, res) => {
    const result = await authService.bootstrapMaster(req.body)
    // 200 chứ không 201: chạy lại trên email đã có thì không tạo thêm gì, `created` trong body
    // mới là chỗ nói rõ lượt này đã làm gì.
    success(res, { message: 'Master ready', data: result })
  }),
}
