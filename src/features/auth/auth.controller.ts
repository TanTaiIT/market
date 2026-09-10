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

  /*
   * POST /auth/google — đăng nhập HOẶC đăng ký, cùng một cửa.
   *
   * Luôn 200 chứ không 201 cho tài khoản mới: client không cần biết hai ca đó khác nhau, và
   * phân biệt bằng mã trạng thái là nói cho người gọi biết email này đã có tài khoản chưa.
   */
  google: catchAsync(async (req, res) => {
    const result = await authService.withGoogle(req.body.idToken)
    success(res, { message: 'Logged in with Google', data: toAuthResponseDto(result) })
  }),

  // POST /auth/login
  login: catchAsync(async (req, res) => {
    const result = await authService.login(req.body)
    success(res, { message: 'Logged in successfully', data: toAuthResponseDto(result) })
  }),

  // POST /auth/logout
  logout: catchAsync(async (req, res) => {
    await authService.logout(req.user!.id)
    success(res, { message: 'Đã đăng xuất khỏi mọi thiết bị' })
  }),

  // POST /auth/refresh
  refresh: catchAsync(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken)
    success(res, { message: 'Token refreshed', data: toAuthResponseDto(result) })
  }),
}
