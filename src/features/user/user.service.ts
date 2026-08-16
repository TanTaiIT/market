import { userRepository } from './user.repository'
import { UpdateProfileInput } from './user.schema'
import { NotFoundError } from '../../common/errors'

/**
 * Tài khoản là toàn cục nên các thao tác ở đây KHÔNG còn scope theo org.
 *
 * `GET /users/:id` vì vậy trả hồ sơ công khai của bất kỳ ai — đúng như trước, vì `PublicProfileDto`
 * mới là ranh giới chống rò rỉ, không phải bộ lọc org. Dữ liệu riêng của org (vai trò, nhóm con)
 * nằm ở `memberships`, không lộ qua đây.
 */
export const userService = {
  async getById(id: string) {
    const user = await userRepository.findById(id)
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async updateProfile(id: string, update: UpdateProfileInput) {
    const user = await userRepository.updateById(id, update)
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async deleteAccount(id: string) {
    const user = await userRepository.softDelete(id)
    if (!user) throw new NotFoundError('User not found')
    return user
  },
}
