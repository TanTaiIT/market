import { AsyncLocalStorage } from 'node:async_hooks'
import { Types } from 'mongoose'
import { TenantScopeMissingError } from './tenant.errors'

export interface TenantScope {
  /** Org của chính request. Mọi thao tác GHI luôn bị ép về đúng org này. `null` khi unscoped. */
  ownOrgId: Types.ObjectId | null
  /**
   * Org được phép ĐỌC. `[ownOrgId]` khi org độc lập; toàn bộ org cùng chain khi org
   * thuộc chain — nhưng chỉ áp cho schema khai báo `chainReadable`.
   */
  chainOrgIds: Types.ObjectId[]
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
 * Dùng cho code chạy NGOÀI request: seed, migration, background job, fan-out thông báo.
 * Tên cố tình xấu và `reason` bắt buộc để `grep -rn "runUnscoped"` liệt kê đủ mọi chỗ
 * có quyền chạm dữ liệu xuyên tenant, kèm lý do ngay tại call site.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return storage.run({ ownOrgId: null, chainOrgIds: [], unscopedReason: reason }, fn)
}
