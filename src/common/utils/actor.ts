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

/**
 * Actor cho thao tác chạy trên CẢ HAI trục (duyệt / gỡ tin) — CHỈ có `id`.
 *
 * Tồn tại để không ai với tay lấy `orgActor` ở đây: nó đòi org trong scope và ném lỗi ngay
 * trước khi ai kịp xét quyền, mà người phụ trách danh mục lẫn master thường chẳng thuộc nhóm
 * nào. Đó đúng là thứ đã khoá chặt trục công khai một thời gian.
 */
export function moderatorActor(req: Request): { id: string } {
  return { id: req.user!.id }
}
