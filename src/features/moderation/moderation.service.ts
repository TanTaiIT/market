import { Types } from 'mongoose'
import { moderationRepository } from './moderation.repository'
import { ActivityQuery, ModListingQuery, SetListingStatusInput } from './moderation.schema'
import { toAuditEventDto } from './moderation.types'
import { listingService } from '../listing/listing.service'
import { categoryService } from '../category/category.service'
import { reportRepository } from '../report/report.repository'
import { userRepository } from '../user/user.repository'
import { AUDIT_ACTION, AuditAction, LISTING_STATUS } from '../../common/constants'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'
import { emitToOrgAdmins } from '../../sockets/emit'

export interface ModeratorActor {
  id: string
  organizationId: string
}

/** Biểu đồ nhịp hoạt động của prototype là 14 ngày. */
const TREND_DAYS = 14

const ACTION_BY_STATUS: Record<string, AuditAction> = {
  [LISTING_STATUS.ACTIVE]: AUDIT_ACTION.LISTING_APPROVE,
  [LISTING_STATUS.REJECTED]: AUDIT_ACTION.LISTING_REJECT,
  [LISTING_STATUS.HIDDEN]: AUDIT_ACTION.LISTING_HIDE,
}

/**
 * Ghi vết kiểm toán rồi phát cho các quản trị đang mở bàn.
 *
 * Dùng chung cho cả `report` (đóng báo cáo cũng là thao tác quản trị) — đó là lý do hàm này
 * export ra ngoài feature thay vì nằm im trong service.
 */
export async function recordAudit(
  actor: { id: string; name: string; organizationId: string },
  entry: { action: AuditAction; summary: string; targetType?: string; targetId?: Types.ObjectId },
) {
  const log = await moderationRepository.recordAudit({
    actorId: new Types.ObjectId(actor.id),
    actorName: actor.name,
    ...entry,
  })
  emitToOrgAdmins(actor.organizationId, 'admin:activity', toAuditEventDto(log))
  return log
}

async function actorName(actor: ModeratorActor): Promise<string> {
  const user = await userRepository.findById(actor.id, actor.organizationId)
  return user?.name ?? 'Quản trị'
}

export const moderationService = {
  /** Một lượt gọi cho cả màn tổng quan — bốn thẻ số, hai biểu đồ. */
  async overview(actor: ModeratorActor) {
    const [stats, categories, openReports, users] = await Promise.all([
      listingService.moderationStats(TREND_DAYS),
      categoryService.list({ includeInactive: true }),
      reportRepository.countOpen(),
      userRepository.countActive(actor.organizationId),
    ])

    const countOf = (status: string) => stats.byStatus.find((row) => row._id === status)?.count ?? 0
    const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Khác'

    return {
      pending: countOf(LISTING_STATUS.PENDING),
      live: countOf(LISTING_STATUS.ACTIVE),
      hidden: countOf(LISTING_STATUS.HIDDEN),
      rejected: countOf(LISTING_STATUS.REJECTED),
      users,
      openReports,
      trend: stats.byDay.map((row) => ({
        day: row._id,
        approved: row.approved,
        pending: row.pending,
      })),
      categories: stats.byCategory.map((row) => ({
        categoryId: row._id.toString(),
        name: nameOf(row._id.toString()),
        count: row.count,
      })),
    }
  },

  async listings(query: ModListingQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await listingService.listForModeration(query.status, pagination)
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  async activity(query: ActivityQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await moderationRepository.paginateAudit(pagination)
    return {
      items: items.map(toAuditEventDto),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  async setListingStatus(id: string, input: SetListingStatusInput, actor: ModeratorActor) {
    const name = await actorName(actor)
    const listing = await listingService.setModerationStatus(id, {
      status: input.status,
      reason: input.reason,
      byUserId: actor.id,
      byName: name,
    })

    const action = ACTION_BY_STATUS[input.status]
    await recordAudit(
      { ...actor, name },
      {
        action,
        summary:
          input.status === LISTING_STATUS.REJECTED
            ? `Từ chối "${listing.title}" · ${input.reason}`
            : `${input.status === LISTING_STATUS.ACTIVE ? 'Ghim' : 'Ẩn'} "${listing.title}"`,
        targetType: 'listing',
        targetId: listing._id,
      },
    )
    return listing
  },

  async removeListing(id: string, actor: ModeratorActor) {
    const name = await actorName(actor)
    const listing = await listingService.removeByModerator(id)

    await recordAudit(
      { ...actor, name },
      {
        action: AUDIT_ACTION.LISTING_REMOVE,
        summary: `Gỡ "${listing!.title}" khỏi bảng`,
        targetType: 'listing',
        targetId: listing!._id,
      },
    )
    return listing
  },
}
