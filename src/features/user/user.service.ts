import { userRepository } from './user.repository'
import {
  AdminUserQuery,
  ClearRejectionsInput,
  SetUserStatusInput,
  UpdateProfileInput,
} from './user.schema'
import { toAdminUserDto } from './user.types'
import { membershipRepository } from '../membership/membership.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { usableMastersExcluding } from '../role-grant/role-grant.service'
import { trustRepository } from '../trust/trust.repository'
import { listingService } from '../listing/listing.service'
import { listingRepository } from '../listing/listing.repository'
import { QUOTA } from '../listing/listing.quota'
import { notificationService } from '../notification/notification.service'
import { SYSTEM_ROLES } from '../../common/constants'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'
import { logger } from '../../config/logger'

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

  /** Bảng người dùng cho master, kèm bậc uy tín đọc theo lô để không N+1. */
  async listForAdmin(query: AdminUserQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await userRepository.paginateAdmin(
      { q: query.q, status: query.status },
      pagination,
    )

    const trustLevels = await trustRepository.levelsOf(items.map((u) => u._id))
    return {
      items: items.map((u) => toAdminUserDto(u, trustLevels.get(u._id.toString()) ?? 0)),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Khoá / mở khoá tài khoản — quyền của MASTER, không phải admin org.
   *
   * Tài khoản ở v2 là toàn cục: admin một org mà khoá được nó là ảnh hưởng sang mọi org khác
   * và cả trục công khai, đúng loại vượt phạm vi mà tenant model đang chặn. Org muốn xử người
   * trong nhóm mình thì công cụ đúng là membership, không phải cái công tắc này.
   *
   * Hiệu lực: đăng nhập và refresh chặn NGAY (`auth.service` đã kiểm `isActive`); access token
   * đang sống thì chạy nốt tối đa `JWT_EXPIRES_IN` (15 phút) — cùng đánh đổi mà multi-tenant
   * convention §5.5 đã chốt cho suspend org: token ngắn chính là cơ chế, đừng thêm một lượt
   * đọc DB vào mọi request chỉ để rút ngắn cái đuôi này.
   */
  async setStatus(id: string, input: SetUserStatusInput, actorId: string) {
    if (id === actorId) {
      throw new BadRequestError('Không tự khoá chính mình — nhờ một master khác')
    }

    const target = await userRepository.findById(id)
    if (!target) throw new NotFoundError('User not found')
    if (target.isActive === input.isActive) {
      throw new ConflictError(input.isActive ? 'Tài khoản đang mở sẵn' : 'Tài khoản đã bị khoá rồi')
    }

    if (!input.isActive) {
      // Không khoá người đang giữ quyền master: một master bị khoá vẫn "đếm là còn" ở mọi phép
      // kiểm "phải luôn còn ít nhất một master" — gỡ quyền trước (đường revoke có sẵn chốt
      // master cuối cùng), rồi mới khoá.
      const grants = await roleGrantRepository.listActiveByUser(id)
      if (grants.some((g) => g.role === SYSTEM_ROLES.MASTER)) {
        throw new ConflictError('Người này đang giữ quyền master — thu hồi quyền trước khi khoá')
      }
    }

    await userRepository.updateById(id, { isActive: input.isActive })

    if (!input.isActive) {
      // Khoá một spammer mà để nguyên tin của họ trên bảng thì mới xử được cái tài khoản, chưa
      // xử được cái spam. Ẩn hết — kể cả tin đang chờ duyệt, để chúng thôi chiếm hàng đợi.
      const hidden = await listingService.hideAllFromSeller(target._id, {
        reason: `Tài khoản bị khoá: ${input.reason}`,
        byUserId: actorId,
      })
      logger.info('user locked', { actorId, userId: id, hiddenListings: hidden })
    }

    // Người bị khoá vẫn đọc được hộp thư tới khi token hết hạn, và sau khi được mở lại — lý do
    // phải nằm ở đó, không thì khiếu nại nào cũng bắt đầu bằng "tôi không biết vì sao".
    await notificationService.notifyUser({
      organizationId: null,
      userId: target._id,
      title: input.isActive ? 'Tài khoản của bạn đã được mở lại' : 'Tài khoản của bạn đã bị khoá',
      body: input.isActive
        ? 'Bạn có thể đăng nhập và sử dụng lại bình thường.'
        : (input.reason ?? ''),
    })

    const updated = await this.getById(id)
    return toAdminUserDto(updated, await trustRepository.levelOf(id))
  },

  /**
   * Gỡ án phạt đăng tin — quyền MASTER.
   *
   * Ba lượt bị từ chối vì vi phạm trong 7 ngày là KHOÁ quyền đăng, và trước endpoint này thì
   * cách duy nhất ra là ngồi đợi cửa sổ trôi qua: comment trong `listing.quota.ts` hứa "cần
   * người gỡ tay" mà không có ai gỡ được, kể cả master.
   *
   * Chỉ gỡ PHANH HẠN MỨC, KHÔNG trả lại bậc uy tín. Bậc mất đi vẫn phải kiếm lại bằng tin
   * sạch — nếu không thì đây thành nút "tha bổng" và bậc uy tín mất hết ý nghĩa.
   */
  async clearRejections(id: string, input: ClearRejectionsInput, actorId: string) {
    const target = await userRepository.findById(id)
    if (!target) throw new NotFoundError('User not found')

    const since = new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const cleared = await listingRepository.downgradeRecentRejections(target._id, since)
    if (cleared === 0) throw new ConflictError('Người này không có án phạt nào đang hiệu lực')

    logger.info('rejection penalty cleared by master', {
      actorId,
      userId: id,
      cleared,
      reason: input.reason,
    })

    // Người bị phạt phải biết án đã hết — không thì họ vẫn tưởng mình đang bị khoá.
    await notificationService.notifyUser({
      organizationId: null,
      userId: target._id,
      title: 'Án phạt đăng tin đã được gỡ',
      body: `${input.reason} — bạn đăng tin lại được bình thường.`,
    })

    return { cleared }
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
