import { userService } from './user.service'
import { toPublicProfileDto } from './user.types'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const userController = {
  // GET /users/me
  getMe: catchAsync(async (req, res) => {
    const user = await userService.getById(req.user!.id)
    success(res, { message: 'Current user', data: user })
  }),

  // PATCH /users/me
  updateMe: catchAsync(async (req, res) => {
    const user = await userService.updateProfile(req.user!.id, req.body)
    success(res, { message: 'Profile updated', data: user })
  }),

  // DELETE /users/me
  deleteMe: catchAsync(async (req, res) => {
    await userService.deleteAccount(req.user!.id)
    success(res, { message: 'Account deleted' })
  }),

  // GET /users/:id  (public profile người bán)
  getById: catchAsync(async (req, res) => {
    const user = await userService.getById(req.params.id)
    success(res, { message: 'User profile', data: toPublicProfileDto(user) })
  }),
}
