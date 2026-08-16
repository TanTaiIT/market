import { IRoleGrantDocument } from './role-grant.model'
import { Grant } from '../../common/authz/policy'

/**
 * Document Mongoose → shape thuần của tầng policy. Policy cố tình không biết Mongoose, nên
 * đây là chỗ duy nhất dịch giữa hai bên (`ObjectId` → `string`).
 */
export function toPolicyGrant(doc: IRoleGrantDocument): Grant {
  return {
    role: doc.role,
    scopeType: doc.scopeType,
    orgId: doc.orgId?.toString() ?? null,
    unitId: doc.unitId?.toString() ?? null,
    categoryId: doc.categoryId?.toString() ?? null,
    provinceCodes: doc.provinceCodes,
  }
}

export function toRoleGrantDto(doc: IRoleGrantDocument) {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    role: doc.role,
    scopeType: doc.scopeType,
    orgId: doc.orgId?.toString() ?? null,
    unitId: doc.unitId?.toString() ?? null,
    categoryId: doc.categoryId?.toString() ?? null,
    provinceCodes: doc.provinceCodes,
    grantedBy: doc.grantedBy?.toString() ?? null,
    grantedAt: doc.grantedAt.toISOString(),
  }
}
