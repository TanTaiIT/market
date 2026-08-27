import { AsyncLocalStorage } from 'node:async_hooks'
import { Types } from 'mongoose'
import { TenantScopeMissingError } from './tenant.errors'

/**
 * Vế thứ hai của scope: quyền đọc trên TRỤC DANH MỤC (tin công khai).
 *
 * Nằm trong scope chứ không nằm ở repository là có chủ ý: repository quên một điều kiện thì
 * dữ liệu chưa duyệt lọt ra ngoài, còn ở đây nó do middleware dựng một lần và `tenantPlugin`
 * áp cho mọi query — cùng lý do khiến vế org nằm ở đây.
 */
export type PublicAxisScope =
  /** Ai cũng có: chỉ thấy tin công khai ĐÃ duyệt. */
  | { mode: 'approved' }
  /**
   * Manager/staff trục danh mục: thấy cả tin chưa duyệt, nhưng chỉ trong ô của mình.
   *
   * `cells: null` = không giới hạn địa lý (master, hoặc grant cấp tỉnh toàn quốc). Mỗi ô:
   * `wards: null` = cả tỉnh (grant cấp tỉnh), mảng = đúng những phường được cấp.
   */
  | {
      mode: 'moderator'
      categoryIds: Types.ObjectId[]
      cells: { province: string; wards: string[] | null }[] | null
    }

export interface TenantScope {
  /** Org của chính request. Mọi thao tác GHI trục org luôn bị ép về đúng org này. */
  ownOrgId: Types.ObjectId | null
  /** Org được phép ĐỌC ở trục org. */
  readableOrgIds: Types.ObjectId[]
  /** `null` = request này không được đọc gì ở trục danh mục. */
  publicAxis: PublicAxisScope | null
  /** Chỉ set trong `runUnscoped`: bỏ filter, và caller phải tự mang organizationId. */
  unscopedReason?: string
}

const storage = new AsyncLocalStorage<TenantScope>()

export function runWithTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentScope(): TenantScope | undefined {
  return storage.getStore()
}

export function requireScope(operation: string): TenantScope {
  const scope = storage.getStore()
  if (!scope) throw new TenantScopeMissingError(operation)
  return scope
}

/**
 * Org hoạt động của request. Service gọi hàm này thay vì nhận `organizationId` qua tham số:
 * tham số đi qua nhiều tầng là nhiều chỗ có thể truyền nhầm org, còn scope thì chỉ có một
 * nguồn duy nhất là middleware đã đối chiếu membership.
 */
export function requireOwnOrgId(operation: string): Types.ObjectId {
  const scope = requireScope(operation)
  if (!scope.ownOrgId) throw new TenantScopeMissingError(operation)
  return scope.ownOrgId
}

/** Scope mặc định của một request chưa gắn org: vẫn đọc được tin công khai đã duyệt. */
export function publicOnlyScope(): TenantScope {
  return { ownOrgId: null, readableOrgIds: [], publicAxis: { mode: 'approved' } }
}

/**
 * Dùng cho code chạy NGOÀI request: seed, migration, background job.
 * Tên cố tình xấu và `reason` bắt buộc để `grep -rn "runUnscoped"` liệt kê đủ mọi chỗ
 * có quyền chạm dữ liệu xuyên tenant, kèm lý do ngay tại call site.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return storage.run(
    { ownOrgId: null, readableOrgIds: [], publicAxis: null, unscopedReason: reason },
    fn,
  )
}
