import { AuditLog, IAuditLog } from './moderation.model'
import { PaginationParams } from '../../common/utils/pagination'

export const moderationRepository = {
  recordAudit(data: Partial<IAuditLog>) {
    return AuditLog.create(data)
  },

  async paginateAudit({ skip, limit }: PaginationParams) {
    const [items, total] = await Promise.all([
      AuditLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditLog.countDocuments(),
    ])
    return { items, total }
  },
}
