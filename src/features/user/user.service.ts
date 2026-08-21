import { userRepository } from './user.repository'
import { UpdateProfileInput } from './user.schema'
import { membershipRepository } from '../membership/membership.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { usableMastersExcluding } from '../role-grant/role-grant.service'
import { SYSTEM_ROLES } from '../../common/constants'
import { ConflictError, NotFoundError } from '../../common/errors'

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

  /**
   * Xoá mềm tài khoản, KÈM thu hồi mọi thứ bám vào nó.
   *
   * Trước đây chỉ set `deletedAt`: membership vẫn `active` nên người đã xoá còn nằm trong danh
   * bạ org, và role_grant vẫn hiệu lực nên quyền của họ còn được đếm là "đang có người giữ".
   *
   * Chốt master đặt ở ĐÂY chứ không chỉ ở `roleGrantService.revoke`: đây là cửa thứ hai dẫn
   * tới cùng một hậu quả — mất master cuối cùng thì không ai cấp lại quyền cho ai được nữa,
   * và chính tài khoản vừa xoá cũng không tự khôi phục được (§5.4).
   */
  async deleteAccount(id: string) {
    const grants = await roleGrantRepository.listActiveByUser(id)
    const isMaster = grants.some((g) => g.role === SYSTEM_ROLES.MASTER)
    if (isMaster && (await usableMastersExcluding(id)) === 0) {
      throw new ConflictError('Bạn là master cuối cùng — cấp quyền cho người khác trước khi xoá')
    }

    // Gỡ quyền TRƯỚC khi tắt tài khoản. Không có transaction ở đây, nên thứ tự chính là thứ
    // quyết định trạng thái lúc hỏng giữa chừng: dừng ở đây để lại một tài khoản còn đăng nhập
    // được nhưng không còn quyền (chạy lại được), còn thứ tự ngược lại để lại đúng thứ hàm này
    // sinh ra để dọn — tài khoản đã xoá mà quyền vẫn hiệu lực.
    await Promise.all([
      roleGrantRepository.revokeAllForUser(id),
      membershipRepository.archiveAllForUser(id),
    ])

    const user = await userRepository.softDelete(id)
    if (!user) throw new NotFoundError('User not found')
    return user
  },
}
