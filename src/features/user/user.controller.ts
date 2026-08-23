import { userService } from './user.service'
import { toMeProfileDto, toPublicProfileDto } from './user.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const userController = {
  // POST /users/:id/clear-rejections
  clearRejections: catchAsync(async (req, res) => {
    const data = await userService.clearRejections(req.params.id, req.body, req.user!.id)
    success(res, { message: 'Rejection penalty cleared', data })
  }),

  // GET /users/me
  getMe: catchAsync(async (req, res) => {
    const user = await userService.getById(req.user!.id)
    success(res, { message: 'Current user', data: toMeProfileDto(user) })
  }),

  // PATCH /users/me
  updateMe: catchAsync(async (req, res) => {
    const user = await userService.updateProfile(req.user!.id, req.body)
    success(res, { message: 'Profile updated', data: toMeProfileDto(user) })
  }),

  // DELETE /users/me
  deleteMe: catchAsync(async (req, res) => {
    await userService.deleteAccount(req.user!.id)
    success(res, { message: 'Account deleted' })
  }),

  // GET /users/:id  (public profile người bán)
  // GET /users
  listForAdmin: catchAsync(async (req, res) => {
    const { items, meta } = await userService.listForAdmin(req.query as never)
    success(res, { message: 'Users', data: items, meta })
  }),

  // PATCH /users/:id/status
  setStatus: catchAsync(async (req, res) => {
    const user = await userService.setStatus(req.params.id, req.body, req.user!.id)
    success(res, { message: user.isActive ? 'User unlocked' : 'User locked', data: user })
  }),

  getById: catchAsync(async (req, res) => {
    const user = await userService.getById(req.params.id)
    success(res, { message: 'User profile', data: toPublicProfileDto(user) })
  }),
}
