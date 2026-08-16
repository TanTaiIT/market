import { Schema, Types, Query, MongooseQueryMiddleware, FilterQuery } from 'mongoose'
import { TenantScope, requireScope } from './tenantContext'
import { CrossTenantWriteError } from './tenant.errors'
import { POST_VISIBILITY, PUBLIC_LISTING_STATUSES } from '../constants'

export interface TenantPluginOptions {
  /**
   * Collection sống trên CẢ HAI trục: bản ghi có `organizationId` (trục org) và bản ghi
   * `organizationId: null` (trục danh mục). Hiện chỉ `Listing`.
   *
   * Khi bật, plugin không tự gán `organizationId` nữa — service phải khai tường minh — nhưng
   * vẫn chặn ghi sang org khác. Đọc thì thành `$or` hai vế, vế công khai lấy từ scope.
   */
  dualAxis?: boolean
}

// Liệt kê đầy đủ, không dùng regex /^find/: nó KHÔNG khớp updateMany/deleteMany/
// countDocuments/distinct — đúng loại sót đã gây bug countDocuments của soft-delete.
const READ_HOOKS = ['find', 'findOne', 'countDocuments', 'distinct'] as const
const WRITE_HOOKS = [
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const

type AnyQuery = Query<unknown, unknown>

function requireOrgId(scope: TenantScope): Types.ObjectId {
  if (!scope.ownOrgId) {
    throw new CrossTenantWriteError(
      `Unscoped operation (${scope.unscopedReason}) must set organizationId explicitly`,
    )
  }
  return scope.ownOrgId
}

function orgPredicate(scope: TenantScope): FilterQuery<unknown> | null {
  const ids = scope.readableOrgIds.length > 0 ? scope.readableOrgIds : null
  return ids ? { organizationId: { $in: ids } } : null
}

/** Vế trục danh mục. `visibility` là khoá của trục, không phải `organizationId` (quyết định Q3). */
function publicPredicate(scope: TenantScope): FilterQuery<unknown> | null {
  const axis = scope.publicAxis
  if (!axis) return null

  if (axis.mode === 'approved') {
    return { visibility: POST_VISIBILITY.PUBLIC, status: { $in: PUBLIC_LISTING_STATUSES } }
  }

  // Người duyệt thấy cả tin CHƯA duyệt, nhưng chỉ trong ô của mình.
  // Mảng RỖNG = không giới hạn (master), `null` ở tỉnh = toàn quốc. Cả hai đều phải là "bỏ
  // điều kiện", không phải `$in: []` — cái đó khoá sạch chính người có quyền rộng nhất.
  const filter: FilterQuery<unknown> = { visibility: POST_VISIBILITY.PUBLIC }
  if (axis.categoryIds.length > 0) filter.category = { $in: axis.categoryIds }
  if (axis.provinceCodes) filter.provinceCode = { $in: axis.provinceCodes }
  return filter
}

/** Hai vế đọc của collection dual-axis. Rỗng = không được đọc gì. */
function readBranches(scope: TenantScope): FilterQuery<unknown>[] {
  const branches: FilterQuery<unknown>[] = []
  const org = orgPredicate(scope)
  if (org) branches.push(org)
  const pub = publicPredicate(scope)
  if (pub) branches.push(pub)
  return branches
}

/**
 * Thay thế RLS của Postgres: chèn filter tenant ở tầng thấp nhất, dưới cả repository.
 * Quên filter trong query mới cũng không lọt — không có scope thì ném lỗi chứ không
 * bao giờ rơi về query toàn DB.
 */
export function tenantPlugin(schema: Schema, options: TenantPluginOptions = {}): void {
  const dualAxis = options.dualAxis ?? false

  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      // Trục danh mục không thuộc org nào -> null là giá trị HỢP LỆ, không phải thiếu dữ liệu.
      required: !dualAxis,
      immutable: true,
      default: dualAxis ? null : undefined,
    },
  })

  for (const hook of READ_HOOKS) {
    schema.pre(hook as MongooseQueryMiddleware, function (this: AnyQuery) {
      const scope = requireScope(hook)
      if (scope.unscopedReason) return

      if (!dualAxis) {
        this.where(orgPredicate(scope) ?? { organizationId: requireOrgId(scope) })
        return
      }

      const branches = readBranches(scope)
      // Không vế nào đọc được: chặn sạch thay vì bỏ filter. Fail-closed vẫn là mặc định.
      if (branches.length === 0) return void this.where({ _id: { $in: [] } })

      // `.and()` chứ KHÔNG phải `.where({ $or })`: `where` gán theo khoá, nên một `$or` của
      // repository (vd bộ lọc `?q=` tìm trong title/description) và `$or` của plugin sẽ ghi đè
      // lẫn nhau — cái nào chạy sau thì thắng, và filter kia biến mất KHÔNG một tiếng động.
      this.and([{ $or: branches }])
    })
  }

  for (const hook of WRITE_HOOKS) {
    schema.pre(hook as MongooseQueryMiddleware, function (this: AnyQuery) {
      const scope = requireScope(hook)
      if (scope.unscopedReason) return

      if (!dualAxis) {
        this.where({ organizationId: requireOrgId(scope) })
        return
      }

      // Trục org: chỉ org của chính mình. Trục danh mục: không có tenant để ép, nên quyền ở
      // đó đến từ quyền sở hữu (service kiểm `seller`) và `role_grants` — xem listing.service.
      const allowed: FilterQuery<unknown>[] = [{ organizationId: null }]
      if (scope.ownOrgId) allowed.push({ organizationId: scope.ownOrgId })
      this.where({ $or: allowed })
    })
  }

  // Đọc metadata cả collection, không nhận filter → không có cách nào chèn tenant vào.
  schema.pre('estimatedDocumentCount', function () {
    throw new CrossTenantWriteError('estimatedDocumentCount bỏ qua tenant filter — dùng count()')
  })

  schema.pre('aggregate', function () {
    const scope = requireScope('aggregate')
    if (scope.unscopedReason) return

    if (!dualAxis) {
      this.pipeline().unshift({
        $match: orgPredicate(scope) ?? { organizationId: requireOrgId(scope) },
      })
      return
    }

    const branches = readBranches(scope)
    this.pipeline().unshift({ $match: branches.length > 0 ? { $or: branches } : { _id: null } })
  })

  // `validate` chứ không phải `save`: Mongoose chạy validation TRƯỚC các pre('save') do
  // plugin đăng ký, nên gán ở pre('save') thì `organizationId is required` đã nổ từ trước.
  schema.pre('validate', function () {
    if (!this.isNew) return
    const scope = requireScope('save')
    if (scope.unscopedReason) {
      if (!dualAxis && !this.get('organizationId')) throw new CrossTenantWriteError()
      return
    }

    if (!dualAxis) {
      // GHI ĐÈ chứ không phải gán mặc định: organizationId do client gửi lên phải bị bỏ qua,
      // nếu chỉ `??=` thì một `Model.create({ ...req.body })` là đủ để ghi sang org khác.
      this.set('organizationId', requireOrgId(scope))
      return
    }

    // Dual-axis: service khai tường minh (org hiện tại hoặc null). Plugin chỉ chặn ghi sang
    // org KHÁC — thứ duy nhất nó còn đủ thông tin để phán.
    const declared = this.get('organizationId') as Types.ObjectId | null
    if (declared && !declared.equals(scope.ownOrgId ?? new Types.ObjectId())) {
      throw new CrossTenantWriteError('Không ghi được vào organization khác')
    }
  })

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    const scope = requireScope('insertMany')
    const rows = (Array.isArray(docs) ? docs : [docs]) as Record<string, unknown>[]

    if (scope.unscopedReason) {
      const orphan = dualAxis ? undefined : rows.find((doc) => !doc.organizationId)
      return next(orphan ? new CrossTenantWriteError() : undefined)
    }

    if (dualAxis) {
      const foreign = rows.find(
        (doc) =>
          doc.organizationId && !(doc.organizationId as Types.ObjectId).equals(scope.ownOrgId!),
      )
      return next(
        foreign ? new CrossTenantWriteError('Không ghi được vào organization khác') : undefined,
      )
    }

    const orgId = requireOrgId(scope)
    rows.forEach((doc) => {
      doc.organizationId = orgId
    })
    next()
  })
}
