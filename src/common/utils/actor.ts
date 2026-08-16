import { Request } from 'express'
import { requireOwnOrgId } from '../tenant/tenantContext'

export interface OrgActor {
  id: string
  organizationId: string
}

/**
 * Actor của một request có org scope.
 *
 * `organizationId` lấy từ TENANT SCOPE, không từ token và không từ body: token không còn mang
 * org (tài khoản là toàn cục), còn body thì client tự đặt được. Scope là nguồn duy nhất đã
 * được `resolveTenant` đối chiếu với `memberships`.
 */
export function orgActor(req: Request, operation: string): OrgActor {
  return {
    id: req.user!.id,
    organizationId: requireOwnOrgId(operation).toString(),
  }
}
