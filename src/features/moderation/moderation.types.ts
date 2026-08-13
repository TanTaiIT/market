import { z } from 'zod'
import { IAuditLogDocument } from './moderation.model'
import { auditEventSchema } from './moderation.schema'

export type AuditEventDto = z.infer<typeof auditEventSchema>

/**
 * `meta` và `targetId` cố tình không lộ ra: chúng phục vụ điều tra ở tầng dữ liệu, còn màn
 * hình chỉ cần câu `summary` đã dựng sẵn lúc ghi.
 */
export function toAuditEventDto(log: IAuditLogDocument): AuditEventDto {
  return {
    id: log._id.toString(),
    actorName: log.actorName,
    action: log.action,
    summary: log.summary,
    createdAt: log.createdAt.toISOString(),
  }
}
