import { Types } from 'mongoose'
import { roleGrantRepository } from './role-grant.repository'
import { toPolicyGrant, toRoleGrantDto } from './role-grant.types'
import { userRepository } from '../user/user.repository'
import { Grant, canGrant, canRevoke } from '../../common/authz/policy'
import { SCOPE_TYPES, SystemRole, ScopeType } from '../../common/constants'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

export interface GrantInput {
  /** Đúng một trong hai — `createRoleGrantSchema` chốt, `resolveRecipientId` quy về id. */
  userId?: string
  userEmail?: string
  role: SystemRole
  scopeType: ScopeType
  orgId?: string | null
  unitId?: string | null
  categoryId?: string | null
  provinceCodes?: string[]
  wardCodes?: string[]
}

/**
 * Còn bao nhiêu master ĐĂNG NHẬP ĐƯỢC nếu bỏ `excludeUserId` ra khỏi danh sách — chốt §5.4.
 *
 * Hai điểm khiến nó không phải là một phép `countDocuments` trên `role_grants`:
 * (1) xoá mềm tài khoản không thu hồi grant, nên grant còn đó mà người thì không vào được nữa;
 * (2) loại trừ chính chủ nhân của grant sắp gỡ, thay vì so tổng với 1 — đếm tổng sẽ chặn nhầm
 *     ca "gỡ grant của một master đã xoá tài khoản" trong khi vẫn còn đúng một master sống.
 *
 * Master rất ít nên hai lượt truy vấn nhỏ rẻ hơn một `$lookup`, và đọc ra ý định rõ hơn hẳn.
 */
export async function usableMastersExcluding(
  excludeUserId: Types.ObjectId | string,
): Promise<number> {
  const ids = await roleGrantRepository.listActiveMasterUserIds()
  const others = ids.filter((id) => !id.equals(excludeUserId))
  return userRepository.countUsable(others)
}

function toId(value?: string | null): Types.ObjectId | null {
  return value ? new Types.ObjectId(value) : null
}

function asPolicyGrant(input: GrantInput): Grant {
  return {
    role: input.role,
    scopeType: input.scopeType,
    orgId: input.orgId ?? null,
    unitId: input.unitId ?? null,
    categoryId: input.categoryId ?? null,
    provinceCodes: input.provinceCodes ?? [],
    wardCodes: input.wardCodes ?? [],
  }
}

/**
 * Quy người nhận về `userId`.
 *
 * Email tồn tại vì không phải người cấp nào cũng có danh bạ để chọn ra id: manager trục
 * (danh mục × tỉnh) không thuộc tổ chức nào, mà email là thứ họ thật sự biết về người mình
 * định giao việc. Cùng đường `organization.grantAdmin` đã đi cho người phụ trách org — và
 * cũng cùng giới hạn: người nhận phải CÓ TÀI KHOẢN trước, đây không phải đường mời người mới.
 *
 * Quy đổi trước khi `canGrant` chạy, nên email không nới thêm một chút thẩm quyền nào: vẫn
 * đúng luật `covers()` như khi truyền id.
 */
async function resolveRecipientId(input: GrantInput): Promise<string> {
  if (input.userId) return input.userId
  // Zod đã chặn ca thiếu cả hai; giữ nhánh này để service còn đúng khi được gọi ngoài route.
  if (!input.userEmail) throw new BadRequestError('Cần userId hoặc userEmail')

  const user = await userRepository.findByEmail(input.userEmail)
  if (!user) {
    throw new NotFoundError(
      `Chưa có tài khoản nào dùng email ${input.userEmail} — người nhận phải đăng ký trước`,
    )
  }
  return user._id.toString()
}

export const roleGrantService = {
  /** Nạp quyền của một người về dạng tầng policy hiểu được. */
  async grantsOf(userId: string): Promise<Grant[]> {
    const docs = await roleGrantRepository.listActiveByUser(userId)
    return docs.map(toPolicyGrant)
  },

  async grant(actorId: string, input: GrantInput) {
    const userId = await resolveRecipientId(input)
    const actorGrants = await this.grantsOf(actorId)
    const grant = asPolicyGrant(input)

    if (!canGrant({ userId: actorId, grants: actorGrants }, { userId, grant })) {
      throw new ForbiddenError('Không đủ thẩm quyền để cấp quyền này')
    }

    try {
      const doc = await roleGrantRepository.create({
        userId: new Types.ObjectId(userId),
        role: input.role,
        scopeType: input.scopeType,
        orgId: toId(input.orgId),
        unitId: toId(input.unitId),
        categoryId: toId(input.categoryId),
        provinceCodes: input.provinceCodes ?? [],
        wardCodes: input.wardCodes ?? [],
        grantedBy: new Types.ObjectId(actorId),
      })
      logger.info('role-grant granted', { actorId, targetUserId: userId, ...grant })
      return toRoleGrantDto(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // Index unique không phân biệt danh sách phường, nên grant phường thứ hai trong cùng
        // danh mục đụng nó. Bảng này APPEND-ONLY: sửa `wardCodes` tại chỗ là xoá vết "ai cho
        // quyền gì, lúc nào", nên đường đúng là thu hồi rồi cấp lại với đủ danh sách.
        if (input.scopeType === SCOPE_TYPES.CATEGORY_WARD) {
          throw new ConflictError(
            'Người này đã có quyền phường trong danh mục đó — thu hồi rồi cấp lại với đủ danh sách phường',
          )
        }
        throw new ConflictError('Người này đã có đúng quyền đó')
      }
      throw err
    }
  },

  async revoke(actorId: string, grantId: string) {
    const doc = await roleGrantRepository.findActiveById(grantId)
    if (!doc) throw new NotFoundError('Grant not found')

    const actorGrants = await this.grantsOf(actorId)
    const target = { userId: doc.userId.toString(), grant: toPolicyGrant(doc) }
    if (!canRevoke({ userId: actorId, grants: actorGrants }, target)) {
      throw new ForbiddenError('Không đủ thẩm quyền để thu hồi quyền này')
    }

    // Không còn chốt §5.4 ở đây: `canRevoke` đã chặn MỌI grant role `master` từ trên, nên
    // nhánh "thu hồi master cuối cùng" không tới được. Master là data mặc định của hệ
    // thống (`scripts/migrate-master.ts`), đổi nó là việc ở tầng dữ liệu chứ không ở API.

    const revoked = await roleGrantRepository.revokeById(grantId, new Types.ObjectId(actorId))
    if (!revoked) throw new NotFoundError('Grant not found')

    logger.info('role-grant revoked', { actorId, grantId, targetUserId: target.userId })
    return toRoleGrantDto(revoked)
  },
}
