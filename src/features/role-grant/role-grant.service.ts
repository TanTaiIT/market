import { Types } from 'mongoose'
import { roleGrantRepository } from './role-grant.repository'
import { toPolicyGrant, toRoleGrantDto } from './role-grant.types'
import { userRepository } from '../user/user.repository'
import { Grant, canGrant, canRevoke } from '../../common/authz/policy'
import { SYSTEM_ROLES, SystemRole, ScopeType } from '../../common/constants'
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

export interface GrantInput {
  userId: string
  role: SystemRole
  scopeType: ScopeType
  orgId?: string | null
  unitId?: string | null
  categoryId?: string | null
  provinceCodes?: string[]
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
  }
}

export const roleGrantService = {
  /** Nạp quyền của một người về dạng tầng policy hiểu được. */
  async grantsOf(userId: string): Promise<Grant[]> {
    const docs = await roleGrantRepository.listActiveByUser(userId)
    return docs.map(toPolicyGrant)
  },

  async grant(actorId: string, input: GrantInput) {
    const actorGrants = await this.grantsOf(actorId)
    const grant = asPolicyGrant(input)

    if (!canGrant({ userId: actorId, grants: actorGrants }, { userId: input.userId, grant })) {
      throw new ForbiddenError('Không đủ thẩm quyền để cấp quyền này')
    }

    try {
      const doc = await roleGrantRepository.create({
        userId: new Types.ObjectId(input.userId),
        role: input.role,
        scopeType: input.scopeType,
        orgId: toId(input.orgId),
        unitId: toId(input.unitId),
        categoryId: toId(input.categoryId),
        provinceCodes: input.provinceCodes ?? [],
        grantedBy: new Types.ObjectId(actorId),
      })
      logger.info('role-grant granted', { actorId, targetUserId: input.userId, ...grant })
      return toRoleGrantDto(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
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

    // §5.4 — hệ thống không có master nào là hệ thống không ai cấp lại được quyền cho ai.
    if (doc.role === SYSTEM_ROLES.MASTER && (await usableMastersExcluding(doc.userId)) === 0) {
      throw new ConflictError('Phải luôn còn ít nhất một master')
    }

    const revoked = await roleGrantRepository.revokeById(grantId, new Types.ObjectId(actorId))
    if (!revoked) throw new NotFoundError('Grant not found')

    logger.info('role-grant revoked', { actorId, grantId, targetUserId: target.userId })
    return toRoleGrantDto(revoked)
  },
}
