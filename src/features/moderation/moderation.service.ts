import { Types } from 'mongoose'
import { moderationRepository } from './moderation.repository'
import { ActivityQuery, ModListingQuery, SetListingStatusInput } from './moderation.schema'
import { toAuditEventDto } from './moderation.types'
import { assertCanModerateListing, listingService } from '../listing/listing.service'
import { listingRepository } from '../listing/listing.repository'
import { IListingDocument } from '../listing/listing.model'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { trustRepository } from '../trust/trust.repository'
import type { TrustState } from '../trust/trust.policy'
import { categoryService } from '../category/category.service'
import { reportRepository } from '../report/report.repository'
import { userRepository } from '../user/user.repository'
import { membershipRepository } from '../membership/membership.repository'
import { notificationService } from '../notification/notification.service'
import {
  AUDIT_ACTION,
  AuditAction,
  LISTING_STATUS,
  ListingStatus,
  MASTER_DISPLAY_NAME,
  MODERATION_QUEUE,
  SCOPE_TYPES,
  ModerationQueue,
  VN_PROVINCE_NAMES,
} from '../../common/constants'
import { Grant } from '../../common/authz/policy'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'
import { emitToOrgAdmins } from '../../sockets/emit'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { logger } from '../../config/logger'

/**
 * CHỈ có `id`. Thao tác duyệt chạy trên cả hai trục, nên "người duyệt thuộc nhóm nào" không
 * phải dữ kiện của nó: thẩm quyền do `assertCanModerateListing` phán theo trục của TIN, còn
 * vết kiểm toán ghi dưới org SỞ HỮU tin (`recordAudit`), không phải org của người bấm.
 */
export interface ModeratorActor {
  id: string
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
 *
 * `subjectOrgId` là org SỞ HỮU đối tượng bị tác động, không phải org của người thao tác, và
 * `null` là giá trị hợp lệ — tin trục danh mục không thuộc org nào. Bắt buộc khai vì nếu để
 * plugin tự lấy org từ scope thì nó lấy nhầm org của NGƯỜI DUYỆT: vết duyệt một tin công khai
 * rơi vào nhật ký của org họ, nơi admin org đó đọc được qua `GET /moderation/activity`.
 *
 * Trục danh mục chưa có chỗ ghi (`AuditLog` là collection có tenant) — ghi log hệ thống rồi đi
 * tiếp, trả `null`. Đây là MỘT đường xử lý cho mọi call-site: trước đây `reroute` tự bỏ qua,
 * `setListingStatus`/`removeListing` thì ghi nhầm, cùng một tình huống mà ba cách khác nhau.
 * Chuyển `AuditLog` sang dual-axis là việc còn nợ (v2-org-permission.plan.md).
 */
export async function recordAudit(
  actor: { id: string; name: string },
  entry: {
    action: AuditAction
    summary: string
    targetType?: string
    targetId?: Types.ObjectId
    fromStatus?: string
    toStatus?: string
    queue?: ModerationQueue
  },
  subjectOrgId: Types.ObjectId | null,
) {
  if (!subjectOrgId) {
    logger.info('audit skipped (public axis has no org to file under)', {
      actorId: actor.id,
      action: entry.action,
      summary: entry.summary,
    })
    return null
  }

  // Khai `organizationId` TƯỜNG MINH và chạy unscoped: để plugin tự lấy từ scope thì vết
  // duyệt rơi vào nhật ký org của NGƯỜI DUYỆT, không phải org sở hữu tin. Cùng lệch đó khiến
  // master duyệt hộ org khác sẽ ghi nhầm sổ — và với người duyệt không có nhóm thì lệnh ghi
  // còn không chạy nổi.
  const log = await runUnscoped('audit: ghi vết dưới org SỞ HỮU đối tượng bị tác động', () =>
    moderationRepository.recordAudit({
      organizationId: subjectOrgId,
      actorId: new Types.ObjectId(actor.id),
      actorName: actor.name,
      ...entry,
    }),
  )
  emitToOrgAdmins(subjectOrgId.toString(), 'admin:activity', toAuditEventDto(log))
  return log
}

/**
 * Một lượt duyệt → một lần ghi uy tín, không phân biệt tin nội bộ hay công khai. Luật thăng
 * giáng nằm ở `trust.policy.ts`, chỗ này chỉ quyết định "có tính không".
 *
 * Chỉ ACTIVE và REJECTED mới tính: ẩn tin (`hidden`) là thao tác vận hành, có thể vì lý do
 * ngoài lỗi người đăng, nên nó không được phép bào mòn uy tín của ai.
 */
async function applyTrustEffect(
  listing: IListingDocument,
  status: ListingStatus,
  context: { actorId: string; previousStatus: ListingStatus },
): Promise<TrustState | null> {
  const approved = status === LISTING_STATUS.ACTIVE
  const rejected = status === LISTING_STATUS.REJECTED
  if (!approved && !rejected) return null

  /*
   * TỰ duyệt tin của chính mình KHÔNG tính. Đây là lỗ farm uy tín, và nó rẻ đến mức không thể
   * để mở: ai có quyền duyệt trong một nhóm chỉ cần đăng rồi tự bấm "duyệt" mười lần là lên
   * bậc 2, rồi tự đăng thẳng lên bảng tin công khai của cả sàn mà không ai từng nhìn qua.
   *
   * `assertCanModerateListing` không chặn được: nó hỏi "có quyền duyệt tin này không", và câu
   * trả lời cho chính chủ đang giữ quyền admin nhóm là CÓ. Việc duyệt vẫn hợp lệ — chỉ có điều
   * nó không phải bằng chứng về uy tín, vì không ai độc lập nhìn tin đó.
   */
  if (listing.seller.toString() === context.actorId) return null

  /*
   * Quyết định trên hàng đợi NGƯỜI-NGOÀI trung tính với uy tín, cả hai chiều.
   *
   * "Tin này không phù hợp nhóm tôi" và "tin này vi phạm quy định sàn" là hai phán quyết khác
   * nhau đang dùng chung một nút. Từ nay người ngoài gửi tin vào một nhóm lạ mà bị từ chối thì
   * chỉ mất tin đó — không mất vị thế trên toàn sàn. Bậc uy tín là MỘT số toàn cục
   * (`trust.model.ts`), nên nếu tính thì quản trị của bất kỳ nhóm nào cũng hạ được uy tín của
   * bất kỳ ai từng gửi tin vào đó, không cần ác ý.
   *
   * Chiều cộng cũng bỏ, không phải cho đối xứng đẹp mà để bịt farm bằng người quen: một nhóm
   * thân thiện bật `allowOutsiderPosts` rồi duyệt tin của bạn mình là đường lên bậc 2 khác.
   */
  if (context.previousStatus === LISTING_STATUS.PENDING_UNVERIFIED) return null

  return trustRepository.record(listing.seller, approved)
}

/**
 * Đuôi " · uy tín bậc N" cho dòng nhật ký.
 *
 * Bậc uy tín đổi âm thầm ở tầng dưới, và nó là thứ quyết định tin sau của người này có tự lên
 * bảng hay không. Không hiện ra đây thì quản trị chỉ thấy "đã từ chối" mà không biết hậu quả
 * thật của cú bấm vừa rồi. Rỗng khi lượt này không đụng tới uy tín (ẩn/hiện lại tin).
 */
const trustNote = (trust: TrustState | null) => (trust ? ` · uy tín bậc ${trust.level}` : '')

/**
 * Báo cho NGƯỜI ĐĂNG kết quả duyệt tin của họ.
 *
 * Lý do từ chối vốn chỉ nằm trong `listing.moderation.reason` — đúng, nhưng đó là dữ liệu KÉO:
 * người đăng phải tự mở lại tin mới biết tin mình bị từ chối và vì sao. Thông báo là vế đẩy.
 *
 * `hidden` cố tình không báo: ẩn là thao tác tạm của quản trị (chờ xác minh, gỡ theo báo cáo),
 * không phải phán quyết về tin — báo cả ba trạng thái sẽ biến hộp thư thành nhật ký quản trị.
 */
export async function notifyPoster(
  listing: IListingDocument,
  status: ListingStatus,
  reason?: string,
): Promise<void> {
  if (status === LISTING_STATUS.ACTIVE) {
    await notificationService.notifyUser({
      organizationId: listing.organizationId,
      userId: listing.seller,
      title: 'Tin của bạn đã được duyệt',
      body: `"${listing.title}" đã lên bảng tin.`,
    })
    return
  }

  if (status === LISTING_STATUS.REJECTED) {
    await notificationService.notifyUser({
      organizationId: listing.organizationId,
      userId: listing.seller,
      title: 'Tin của bạn bị từ chối',
      body: `"${listing.title}" — ${reason ?? 'Quản trị không nêu lý do.'}`,
    })
    return
  }

  // Ẩn tin cũng phải báo. Bản trước bỏ qua nhánh này, nên tin biến mất khỏi bảng mà người bán
  // không có cách nào biết vì sao — họ chỉ thấy lượt xem đứng im.
  if (status === LISTING_STATUS.HIDDEN) {
    await notificationService.notifyUser({
      organizationId: listing.organizationId,
      userId: listing.seller,
      title: 'Tin của bạn đã bị ẩn',
      body: `"${listing.title}" — ${reason ?? 'Quản trị không nêu lý do.'}`,
    })
  }
}

/** Gỡ hẳn tin khỏi bảng: nặng hơn ẩn, và cũng là thứ người bán cần biết ngay nhất. */
async function notifyRemoved(listing: IListingDocument): Promise<void> {
  await notificationService.notifyUser({
    organizationId: listing.organizationId,
    userId: listing.seller,
    title: 'Tin của bạn đã bị gỡ',
    body: `"${listing.title}" không còn trên bảng tin.`,
  })
}

/**
 * Tên đi vào snapshot `audit_logs.actorName` — nhật ký này moderator của org đọc được.
 *
 * Master duyệt tin trong một org thì org đó KHÔNG được biết tên thật của họ: master là
 * danh tính hệ thống, không phải người trong nhóm. Che ở đây (lúc GHI) chứ không lúc đọc —
 * `actorName` là snapshot, che lúc đọc thì tên thật vẫn nằm sẵn trong DB của từng org.
 */
async function actorName(actor: ModeratorActor): Promise<string> {
  if (await roleGrantRepository.isMasterUser(actor.id)) return MASTER_DISPLAY_NAME
  const user = await userRepository.findById(actor.id)
  return user?.name ?? 'Quản trị'
}

export const moderationService = {
  /** Một lượt gọi cho cả màn tổng quan — bốn thẻ số, hai biểu đồ. */
  async overview(actor: { id: string; organizationId: string }) {
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

  /**
   * Tổng quan của TRỤC DANH MỤC — bản đối xứng của `overview` cho ô (danh mục × phường).
   *
   * KHÔNG có `users`/`openReports`: cả hai là số của MỘT tổ chức (`memberships` và `reports` đều
   * là collection có tenant), còn trục danh mục không có khái niệm thành viên. Số tin thì đi đúng
   * đường `overview` đang đi — `moderationStats` chạy qua `tenantPlugin`, nên scope do
   * `requireCategoryModerator` dựng đã cắt sẵn theo ô của người gọi; service KHÔNG lọc lần nữa,
   * lọc ở hai nơi là mở đường cho hai kết quả khác nhau.
   */
  async publicOverview() {
    const [stats, categories] = await Promise.all([
      listingService.moderationStats(TREND_DAYS),
      categoryService.list({ includeInactive: true }),
    ])

    const countOf = (status: string) => stats.byStatus.find((row) => row._id === status)?.count ?? 0
    const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Khác'

    return {
      pending: countOf(LISTING_STATUS.PENDING),
      live: countOf(LISTING_STATUS.ACTIVE),
      hidden: countOf(LISTING_STATUS.HIDDEN),
      rejected: countOf(LISTING_STATUS.REJECTED),
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
    const existing = await listingService.getForModeration(id)
    assertCanModerateListing(existing, actor.grants)

    const name = await actorName(actor)
    const previousStatus = existing.status
    const listing = await listingService.setModerationStatus(
      id,
      {
        status: input.status,
        reason: input.reason,
        byUserId: actor.id,
        byName: name,
        severity: input.severity,
      },
      actor.grants,
    )

    // Ghi uy tín TRƯỚC khi log: dòng nhật ký phải nói được hậu quả, mà hậu quả chỉ biết sau
    // khi đã ghi. Thứ tự ngược lại thì bậc trong log luôn là bậc cũ.
    const trust = await applyTrustEffect(listing, input.status, {
      actorId: actor.id,
      previousStatus,
    })

    const action = ACTION_BY_STATUS[input.status]
    await recordAudit(
      { ...actor, name },
      {
        action,
        summary:
          input.status === LISTING_STATUS.REJECTED
            ? `Từ chối "${listing.title}" · ${input.reason}${trustNote(trust)}`
            : `${input.status === LISTING_STATUS.ACTIVE ? 'Ghim' : 'Ẩn'} "${listing.title}"${trustNote(trust)}`,
        targetType: 'listing',
        targetId: listing._id,
        fromStatus: previousStatus,
        toStatus: input.status,
      },
      listing.organizationId,
    )

    await notifyPoster(listing, input.status, input.reason)
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
    const grants = await roleGrantRepository.listCategoryAxisGrants()
    const byCategory = new Map<
      string,
      { nationwide: boolean; covered: Set<string>; partial: Set<string> }
    >()
    for (const grant of grants) {
      const key = grant.categoryId!.toString()
      const entry = byCategory.get(key) ?? {
        nationwide: false,
        covered: new Set<string>(),
        partial: new Set<string>(),
      }
      // Grant cấp PHƯỜNG chỉ phủ MỘT PHẦN tỉnh. Gộp nó vào `covered` là báo với master rằng tỉnh
      // đó đã có người lo — sai đúng chiều nguy hiểm: master thôi không tuyển thêm ai nữa.
      if (grant.scopeType === SCOPE_TYPES.CATEGORY_WARD) {
        grant.provinceCodes.forEach((code) => entry.partial.add(code))
      } else {
        if (grant.provinceCodes.length === 0) entry.nationwide = true
        grant.provinceCodes.forEach((code) => entry.covered.add(code))
      }
      byCategory.set(key, entry)
    }

    const cells = []
    for (const category of categories) {
      const {
        nationwide = false,
        covered = new Set<string>(),
        partial = new Set<string>(),
      } = byCategory.get(category.id) ?? {}

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
          partialByWard: !hasModerator && partial.has(province),
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

    // Không còn nhánh if/else cho trục danh mục: `recordAudit` tự xử lý `organizationId: null`
    // — cùng một cách với mọi thao tác duyệt khác, thay vì riêng chỗ này biết bỏ qua.
    const orgId = listing.organizationId
    const name = await actorName({ id: actorId })
    await recordAudit(
      { id: actorId, name },
      {
        action: AUDIT_ACTION.LISTING_REASSIGN,
        summary,
        targetType: 'listing',
        targetId: listing._id,
        fromStatus: before.status,
        toStatus: listing.status,
        queue: MODERATION_QUEUE.CATEGORY,
      },
      orgId,
    )

    return listing
  },

  async removeListing(id: string, actor: ModeratorActor & { grants: Grant[] }) {
    assertCanModerateListing(await listingService.getForModeration(id), actor.grants)

    const name = await actorName(actor)
    const listing = await listingService.removeByModerator(id, actor.grants)

    // Gỡ tin tính như một lần bị từ chối. Nặng hơn thì đúng hơn — tin này đã LỌT qua hệ thống
    // và đã tới tay người mua, khác hẳn tin bị chặn từ hàng đợi — nhưng thang bậc hiện tại chỉ
    // có một nấc giáng. Phân mức độ vi phạm là việc của hệ điểm mới, không phải chỗ này.
    const trust = await trustRepository.record(listing!.seller, false)
    await notifyRemoved(listing!)

    await recordAudit(
      { ...actor, name },
      {
        action: AUDIT_ACTION.LISTING_REMOVE,
        summary: `Gỡ "${listing!.title}" khỏi bảng${trustNote(trust)}`,
        targetType: 'listing',
        targetId: listing!._id,
      },
      listing!.organizationId,
    )
    return listing
  },
}
