import { Schema, Types, Query, MongooseQueryMiddleware } from 'mongoose'
import { TenantScope, requireScope } from './tenantContext'
import { CrossTenantWriteError } from './tenant.errors'

export interface TenantPluginOptions {
  /**
   * true → ĐỌC mở rộng ra mọi org cùng chain (hiện chỉ `Listing`, quyết định #15/#16).
   * Ghi thì không bao giờ mở rộng, bất kể cờ này.
   */
  chainReadable?: boolean
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

function readableOrgIds(scope: TenantScope, chainReadable: boolean): Types.ObjectId[] {
  return chainReadable ? scope.chainOrgIds : [requireOrgId(scope)]
}

/**
 * Thay thế RLS của Postgres: chèn filter tenant ở tầng thấp nhất, dưới cả repository.
 * Quên filter trong query mới cũng không lọt — không có scope thì ném lỗi chứ không
 * bao giờ rơi về query toàn DB.
 */
export function tenantPlugin(schema: Schema, options: TenantPluginOptions = {}): void {
  const chainReadable = options.chainReadable ?? false

  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      immutable: true,
    },
  })

  for (const hook of READ_HOOKS) {
    schema.pre(hook as MongooseQueryMiddleware, function (this: AnyQuery) {
      const scope = requireScope(hook)
      if (scope.unscopedReason) return
      this.where({ organizationId: { $in: readableOrgIds(scope, chainReadable) } })
    })
  }

  for (const hook of WRITE_HOOKS) {
    schema.pre(hook as MongooseQueryMiddleware, function (this: AnyQuery) {
      const scope = requireScope(hook)
      if (scope.unscopedReason) return
      this.where({ organizationId: requireOrgId(scope) })
    })
  }

  // Đọc metadata cả collection, không nhận filter → không có cách nào chèn tenant vào.
  schema.pre('estimatedDocumentCount', function () {
    throw new CrossTenantWriteError('estimatedDocumentCount bỏ qua tenant filter — dùng count()')
  })

  schema.pre('aggregate', function () {
    const scope = requireScope('aggregate')
    if (scope.unscopedReason) return
    this.pipeline().unshift({
      $match: { organizationId: { $in: readableOrgIds(scope, chainReadable) } },
    })
  })

  // `validate` chứ không phải `save`: Mongoose chạy validation TRƯỚC các pre('save') do
  // plugin đăng ký, nên gán ở pre('save') thì `organizationId is required` đã nổ từ trước.
  //
  // GHI ĐÈ chứ không phải gán mặc định: organizationId do client gửi lên phải bị bỏ qua,
  // nếu chỉ `??=` thì một `Model.create({ ...req.body })` là đủ để ghi sang org khác.
  schema.pre('validate', function () {
    if (!this.isNew) return
    const scope = requireScope('save')
    if (scope.unscopedReason) {
      if (!this.get('organizationId')) throw new CrossTenantWriteError()
      return
    }
    this.set('organizationId', requireOrgId(scope))
  })

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    const scope = requireScope('insertMany')
    const rows = (Array.isArray(docs) ? docs : [docs]) as Record<string, unknown>[]

    if (scope.unscopedReason) {
      const orphan = rows.find((doc) => !doc.organizationId)
      return next(orphan ? new CrossTenantWriteError() : undefined)
    }

    const orgId = requireOrgId(scope)
    rows.forEach((doc) => {
      doc.organizationId = orgId
    })
    next()
  })
}
