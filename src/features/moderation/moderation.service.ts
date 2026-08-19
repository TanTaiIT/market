import { Types } from 'mongoose'
import { moderationRepository } from './moderation.repository'
import { ActivityQuery, ModListingQuery, SetListingStatusInput } from './moderation.schema'
import { toAuditEventDto } from './moderation.types'
import { listingService } from '../listing/listing.service'
import { listingRepository } from '../listing/listing.repository'
import { IListingDocument } from '../listing/listing.model'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { trustRepository } from '../trust/trust.repository'
import { categoryService } from '../category/category.service'
import { reportRepository } from '../report/report.repository'
import { userRepository } from '../user/user.repository'
import { membershipRepository } from '../membership/membership.repository'
import {
  AUDIT_ACTION,
  AuditAction,
  LISTING_STATUS,
  ListingStatus,
  MODERATION_QUEUE,
  ModerationQueue,
  POST_VISIBILITY,
  VN_PROVINCE_NAMES,
} from '../../common/constants'
import { ForbiddenError } from '../../common/errors'
import { Grant, canModerateCategory, canModerateOrg } from '../../common/authz/policy'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'
import { emitToOrgAdmins } from '../../sockets/emit'
import { logger } from '../../config/logger'

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
  entry: {
    action: AuditAction
    summary: string
    targetType?: string
    targetId?: Types.ObjectId
    fromStatus?: string
    toStatus?: string
    queue?: ModerationQueue
  },
) {
  const log = await moderationRepository.recordAudit({
    actorId: new Types.ObjectId(actor.id),
    actorName: actor.name,
    ...entry,
  })
  emitToOrgAdmins(actor.organizationId, 'admin:activity', toAuditEventDto(log))
  return log
}

/** Bao nhiêu bài sạch thì lên một bậc — §8.3: "đã có 5 bài duyệt sạch". */
const CLEAN_APPROVALS_PER_LEVEL = 5

/**
 * Uy tín đi theo TRỤC của chính tin đó, không cộng dồn sang trục kia (§8.3): tin nội bộ nâng
 * `memberships.trustLevel` của org đó, tin công khai nâng `PublicTrust` của đúng danh mục.
 * Cộng chung là biến 5 bài sạch trong một nhóm nhỏ thành quyền tự đăng ra toàn tỉnh.
 */
async function applyTrustEffect(listing: IListingDocument, status: ListingStatus): Promise<void> {
  const approved = status === LISTING_STATUS.ACTIVE
  const rejected = status === LISTING_STATUS.REJECTED
  if (!approved && !rejected) return

  if (listing.visibility === POST_VISIBILITY.PUBLIC) {
    await (approved
      ? trustRepository.recordApproval(listing.seller, listing.category, CLEAN_APPROVALS_PER_LEVEL)
      : trustRepository.recordRejection(listing.seller, listing.category))
    return
  }

  if (!listing.organizationId) return
  await membershipRepository.adjustTrust(listing.seller, listing.organizationId, {
    approved,
    promoteEvery: CLEAN_APPROVALS_PER_LEVEL,
  })
}

/**
 * Chốt phạm vi THẬT của một thao tác duyệt.
 *
 * Route cố tình chỉ hỏi "có duyệt được thứ gì đó trong org này không" (`requireOrgModerator`,
 * rule 5). Dừng ở đó thì một quản lý org: (1) tự ghim được tin TRỤC CÔNG KHAI của thành viên
 * lên trang chung, bỏ qua người phụ trách danh mục — trái đúng thứ `listing.routing.ts` chốt;
 * và (2) vì nhánh đọc công khai của `tenantPlugin` cho thấy mọi tin public đã duyệt, họ ẩn
 * được cả tin của người ngoài org.
 *
 * Trục nào luật nấy, cùng cặp hàm mà `listing.routing.ts` dùng để định tuyến: công khai → ô
 * (danh mục × tỉnh), nội bộ → chính org đó (staff phải đúng nhóm con).
 *
 * 403 chứ không 404: bàn duyệt vừa liệt kê tin này ra, giấu sự tồn tại của nó không còn nghĩa.
 */
function assertCanModerate(listing: IListingDocument, grants: Grant[]): void {
  if (listing.visibility === POST_VISIBILITY.PUBLIC) {
    const target = {
      categoryId: listing.category.toString(),
      provinceCode: listing.provinceCode ?? '',
    }
    if (canModerateCategory(grants, target)) return
    throw new ForbiddenError('Tin công khai do người phụ trách danh mục duyệt, không phải tổ chức')
  }

  const target = {
    orgId: listing.organizationId?.toString() ?? '',
    unitId: listing.unitId?.toString() ?? null,
  }
  if (canModerateOrg(grants, target)) return
  throw new ForbiddenError('Tin này không thuộc phạm vi duyệt của bạn')
}

async function actorName(actor: ModeratorActor): Promise<string> {
  const user = await userRepository.findById(actor.id)
  return user?.name ?? 'Quản trị'
}

export const moderationService = {
  /** Một lượt gọi cho cả màn tổng quan — bốn thẻ số, hai biểu đồ. */
  async overview(actor: ModeratorActor) {
    const [stats, categories, openReports, users] = await Promise.all([
      listingService.moderationStats(TREND_DAYS),
      categoryService.list({ includeInactive: true }),
      reportRepository.countOpen(),
      membershipRepository.countActiveByOrganization(actor.organizationId),
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

  async setListingStatus(
    id: string,
    input: SetListingStatusInput,
    actor: ModeratorActor & { grants: Grant[] },
  ) {
    const existing = await listingService.getById(id)
    assertCanModerate(existing, actor.grants)

    const name = await actorName(actor)
    const previousStatus = existing.status
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
        fromStatus: previousStatus,
        toStatus: input.status,
      },
    )

    await applyTrustEffect(listing, input.status)
    return listing
  },

  /**
   * Hàng đợi TRỤC DANH MỤC. Không nhận `categoryId`/`province` từ query để "giới hạn" — phạm
   * vi đã do `requireCategoryModerator` đặt vào scope, và tầng plugin áp nó. Query ở đây chỉ
   * chọn trạng thái muốn xem.
   */
  async publicQueue(query: ModListingQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await listingRepository.paginateForPublicModeration(
      query.status,
      pagination,
    )
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Ma trận phủ sóng cho master: 34 tỉnh × N danh mục. Mỗi ô KHÔNG có người phụ trách là một
   * dòng chảy đổ thẳng vào master, nên nó phải nhìn thấy được trước khi master chết chìm —
   * đây chính là thứ §11.1 cảnh báo.
   */
  async coverage() {
    const [categories, backlog] = await Promise.all([
      categoryService.list({ includeInactive: false }),
      listingRepository.pendingByCategoryProvince(),
    ])

    const backlogOf = (categoryId: string, province: string) =>
      backlog.find(
        (row) => row._id.category?.toString() === categoryId && row._id.province === province,
      )?.count ?? 0

    // Một query cho MỌI danh mục rồi nhóm trong bộ nhớ. Hỏi từng danh mục một là N+1 ngay trên
    // màn hình mà master mở thường xuyên nhất.
    const grants = await roleGrantRepository.listCategoryProvinceGrants()
    const byCategory = new Map<string, { nationwide: boolean; covered: Set<string> }>()
    for (const grant of grants) {
      const key = grant.categoryId!.toString()
      const entry = byCategory.get(key) ?? { nationwide: false, covered: new Set<string>() }
      if (grant.provinceCodes.length === 0) entry.nationwide = true
      grant.provinceCodes.forEach((code) => entry.covered.add(code))
      byCategory.set(key, entry)
    }

    const cells = []
    for (const category of categories) {
      const { nationwide = false, covered = new Set<string>() } = byCategory.get(category.id) ?? {}

      for (const province of VN_PROVINCE_NAMES) {
        const hasModerator = nationwide || covered.has(province)
        const pending = backlogOf(category.id, province)
        // Ô có người và không tồn đọng là ô bình thường — không nhồi vào response cho dài.
        if (hasModerator && pending === 0) continue
        cells.push({
          categoryId: category.id,
          categoryName: category.name,
          provinceCode: province,
          hasModerator,
          pending,
        })
      }
    }

    return {
      totalCells: categories.length * VN_PROVINCE_NAMES.length,
      uncovered: cells.filter((c) => !c.hasModerator).length,
      backlog: cells.reduce((sum, c) => sum + c.pending, 0),
      cells,
    }
  },

  /**
   * Master đổi ô của một tin (§11.3). Đây là "reassign" của thiết kế: hàng đợi suy ra từ
   * (danh mục × tỉnh), nên chuyển người phụ trách chính là chuyển ô. Tin quay về đầu hàng đợi
   * mới + để lại vết, thay vì lặng lẽ nhảy chỗ.
   */
  async reroute(
    id: string,
    input: { categoryId?: string; provinceCode?: string },
    actorId: string,
  ) {
    const before = await listingService.getById(id)
    const listing = await listingService.rerouteListing(id, input)

    const summary =
      `Chuyển "${listing.title}" sang ô ` +
      `${input.categoryId ?? before.category.toString()} · ${input.provinceCode ?? before.provinceCode ?? '—'}`

    if (listing.organizationId) {
      const name = await actorName({
        id: actorId,
        organizationId: listing.organizationId.toString(),
      })
      await recordAudit(
        { id: actorId, name, organizationId: listing.organizationId.toString() },
        {
          action: AUDIT_ACTION.LISTING_REASSIGN,
          summary,
          targetType: 'listing',
          targetId: listing._id,
          fromStatus: before.status,
          toStatus: listing.status,
          queue: MODERATION_QUEUE.CATEGORY,
        },
      )
    } else {
      // Tin trục danh mục không thuộc org nào, mà `AuditLog` vẫn là collection có tenant —
      // chưa có chỗ để ghi vết. Tạm ghi log hệ thống; chuyển AuditLog sang dual-axis là việc
      // còn nợ, đã ghi trong v2-org-permission.plan.md.
      logger.info('listing rerouted (public axis)', { actorId, listingId: id, summary })
    }

    return listing
  },

  async removeListing(id: string, actor: ModeratorActor & { grants: Grant[] }) {
    assertCanModerate(await listingService.getById(id), actor.grants)

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
