import { Types } from 'mongoose'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { reportRepository } from './report.repository'
import { CreateReportInput, ReportQuery, ResolveReportInput } from './report.schema'
import { IReport, IReportDocument } from './report.model'
import { assertCanActOnListing, listingService } from '../listing/listing.service'
import type { TrustState } from '../trust/trust.policy'
import { userRepository } from '../user/user.repository'
import {
  applyTakedownPenalty,
  notifyPoster,
  recordAudit,
  trustNote,
} from '../moderation/moderation.service'
import {
  AUDIT_ACTION,
  LISTING_REACH,
  LISTING_STATUS,
  MASTER_DISPLAY_NAME,
  MODERATION_ACTION,
  REPORT_STATUS,
  REPORT_TARGET,
} from '../../common/constants'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import { Grant, canModerateAnyInOrg, isMaster } from '../../common/authz/policy'
import { currentScope } from '../../common/tenant/tenantContext'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

/** Người gửi báo cáo — chỉ cần `id`: trục của báo cáo lấy từ ĐỐI TƯỢNG, không từ người gửi. */
export interface ReportActor {
  id: string
}

export interface ReportModerator extends ReportActor {
  grants: Grant[]
}

function toDto(report: IReportDocument, count: number) {
  return {
    id: report._id.toString(),
    targetType: report.targetType,
    targetId: report.targetId.toString(),
    targetTitle: report.targetTitle,
    kind: report.kind,
    quote: report.quote,
    reporterName: report.reporterName,
    status: report.status,
    count,
    createdAt: report.createdAt.toISOString(),
  }
}

/** Toạ độ trục của đối tượng bị báo cáo — thứ quyết định AI xử báo cáo này. */
type ReportTarget = Pick<
  IReport,
  'targetTitle' | 'organizationId' | 'category' | 'provinceCode' | 'wardCode'
>

/**
 * Snapshot đối tượng bị báo cáo (§2.3 cấm populate), và quan trọng hơn: TRỤC của nó.
 *
 * Báo cáo đi theo trục của TIN, không theo org của người tố. Bản cũ để `tenantPlugin` đóng dấu
 * org của người tố, nên phải chặn tin công khai bằng câu "sắp có": ba org tố cùng một tin là ba
 * hàng đợi rời nhau mà không ai trong đó xử được, còn người không thuộc org nào thì 500. Giờ:
 *
 * - tin nội bộ → `organizationId` của tin: quản trị org đó xử;
 * - tin công khai → `null` + toạ độ ô (`category`, `provinceCode`, `wardCode`): người phụ trách ô
 *   xử, master là fallback — đúng luật của hàng đợi duyệt (`assertCanActOnListing`).
 *
 * "Công khai" xét theo `reach`, KHÔNG theo `organizationId`: tin sàn do thành viên đăng vẫn mang
 * badge nhóm, mà bản trước dùng badge đó làm trục nên báo cáo rơi vào hàng đợi của nhóm — người
 * phụ trách ô không bao giờ thấy, và nhóm thì gỡ được nhưng không ghi được án (cửa gỡ). Tin sàn
 * của thành viên vì thế gần như miễn hậu kiểm. Nhóm cầm id vẫn gỡ được qua `canTakedownListing`.
 *
 * Báo cáo về NGƯỜI không có trục tự nhiên: đóng dấu org người tố đang đứng (như trước), không
 * có org thì lên trục công khai và chỉ master xử (xem `assertCanResolve`).
 *
 * `getForViewer` xét theo QUAN HỆ của người tố: tin họ không đọc được (tin nội bộ của nhóm mình
 * không thuộc về, tin công khai chưa duyệt) là 404 ngay ở đây — không báo cáo được thứ mình
 * không thấy. Theo quan hệ chứ không theo scope của request, nên thành viên hai nhóm đang đứng
 * ở nhóm A vẫn báo cáo được tin nội bộ của nhóm B mà họ cũng thuộc về.
 */
async function targetOf(input: CreateReportInput, reporterId: string): Promise<ReportTarget> {
  if (input.targetType === REPORT_TARGET.LISTING) {
    const listing = await listingService.getForViewer(input.targetId, reporterId)
    const isPublic = listing.reach === LISTING_REACH.MARKETPLACE
    return {
      targetTitle: listing.title,
      organizationId: isPublic ? null : (listing.organizationId ?? null),
      category: isPublic ? listing.category : null,
      provinceCode: isPublic ? listing.provinceCode : null,
      wardCode: isPublic ? listing.wardCode : null,
    }
  }

  const user = await userRepository.findById(input.targetId)
  if (!user) throw new NotFoundError('Không tìm thấy người dùng này')
  return {
    targetTitle: user.name,
    organizationId: currentScope()?.ownOrgId ?? null,
    category: null,
    provinceCode: null,
    wardCode: null,
  }
}

/**
 * Thẩm quyền đóng MỘT báo cáo, theo trục của nó — đối xứng với `assertCanActOnListing`.
 *
 * - Trục org: duyệt được gì đó trong org đó (`canModerateAnyInOrg`). Không → 404, không phải 403:
 *   xác nhận "báo cáo này tồn tại" cho người ngoài org là máy dò hồ sơ của tổ chức khác.
 * - Trục công khai, báo cáo về TIN: đúng phép kiểm ô của chính tin đó — người phụ trách ô khác
 *   thấy 403 với lý do rõ ràng.
 * - Trục công khai, báo cáo về NGƯỜI: chỉ master, vì không có ô nào để quy về.
 */
async function assertCanResolve(report: IReportDocument, grants: Grant[]): Promise<void> {
  if (report.organizationId) {
    if (!canModerateAnyInOrg(grants, report.organizationId.toString())) {
      throw new NotFoundError('Report not found')
    }
    return
  }

  if (report.targetType === REPORT_TARGET.LISTING) {
    const listing = await listingService.getForModeration(report.targetId.toString())
    // Cửa GỠ: đóng một báo cáo là rút tin xuống, không phải cho tin đi tiếp. Điều này vá luôn
    // một đường nửa vời — `targetOf` đóng dấu `organizationId` của tin công khai mang org lên
    // báo cáo, nên nhóm MỞ được báo cáo rồi lại 403 khi định xử nó.
    assertCanActOnListing(listing, grants, MODERATION_ACTION.TAKEDOWN)
    return
  }

  if (!isMaster(grants)) {
    throw new ForbiddenError('Báo cáo về người dùng ngoài tổ chức do master xử')
  }
}

export const reportService = {
  async create(input: CreateReportInput, actor: ReportActor) {
    if (input.targetId === actor.id) throw new BadRequestError('Không tự báo cáo chính mình')

    const [target, reporter] = await Promise.all([
      targetOf(input, actor.id),
      userRepository.findById(actor.id),
    ])
    if (!reporter) throw new NotFoundError('User not found')

    try {
      const report = await reportRepository.create({
        ...target,
        targetType: input.targetType,
        targetId: new Types.ObjectId(input.targetId),
        kind: input.kind,
        quote: input.quote,
        reporterId: reporter._id,
        // Snapshot này người duyệt đọc được — master báo cáo thì che tên thật, cùng lý do với
        // `audit_logs.actorName`.
        reporterName: (await roleGrantRepository.isMasterUser(reporter._id))
          ? MASTER_DISPLAY_NAME
          : reporter.name,
      })
      return toDto(report, 1)
    } catch (err) {
      // Unique index chặn một người báo cáo cùng đối tượng hai lần khi chưa xử xong.
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError('Bạn đã báo cáo đối tượng này rồi, quản trị đang xem xét')
      }
      throw err
    }
  },

  /** Hàng đợi theo scope đã dựng ở `requireReportReader` — plugin lo việc lọc hai trục. */
  async list(query: ReportQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await reportRepository.paginate(query.status, pagination)
    const counts = await reportRepository.countsByTarget(items.map((r) => r.targetId))

    return {
      items: items.map((r) => toDto(r, counts.get(r.targetId.toString()) ?? 1)),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Đóng báo cáo. `hide_target` ẩn luôn tin bị nhắm tới — báo cáo về người dùng thì chỉ đóng,
   * vì khoá tài khoản là thao tác nặng hơn và thuộc màn Người dùng.
   */
  async resolve(id: string, input: ResolveReportInput, actor: ReportModerator) {
    const report = await reportRepository.findByIdForModeration(id)
    if (!report) throw new NotFoundError('Report not found')
    await assertCanResolve(report, actor.grants)
    if (report.status !== REPORT_STATUS.OPEN) {
      throw new BadRequestError('Báo cáo này đã được xử lý rồi')
    }

    const moderator = await userRepository.findById(actor.id)
    const byName = moderator?.name ?? 'Quản trị'
    const hideTarget = input.action === 'hide_target' && report.targetType === REPORT_TARGET.LISTING
    /** Bậc uy tín sau khi trừ — chỉ có khi báo cáo được xác minh. Dùng cho dòng nhật ký. */
    let trust: TrustState | null = null

    if (hideTarget) {
      // Trạng thái TRƯỚC khi ẩn — `applyTakedownPenalty` cần nó để biết tin đã từng lên bảng chưa.
      const before = await listingService.getForModeration(report.targetId.toString())

      // `grants` là bắt buộc: `setModerationStatus` tự chốt phạm vi duyệt theo TRỤC của tin —
      // cùng phép kiểm `assertCanResolve` vừa làm, giữ lại vì đây là hàm public có caller khác.
      const hidden = await listingService.setModerationStatus(
        report.targetId.toString(),
        {
          status: LISTING_STATUS.HIDDEN,
          reason: `Bị báo cáo: ${report.kind}`,
          byUserId: actor.id,
          byName,
        },
        actor.grants,
      )

      /*
       * Uy tín trừ ở ĐÂY chứ không ở `applyTrustEffect` (hàm đó cố tình bỏ qua `hidden`: ẩn tin
       * là thao tác vận hành). Ẩn vì một báo cáo ĐÃ ĐƯỢC XÁC MINH thì khác — tin đã lọt qua
       * kiểm duyệt, tới tay người mua, rồi mới bị chính họ tố giác.
       *
       * Nhưng đi qua `applyTakedownPenalty` chứ không `record` thẳng: cửa `hide_target` mở cho cả
       * quản trị nhóm với tin sàn mang badge nhóm (`canTakedownListing`), mà án uy tín trên toàn
       * sàn thì chỉ người có quyền DUYỆT trục đó mới ghi được. Bản trước để nhóm tự báo cáo rồi
       * tự gỡ là hạ bậc bất kỳ ai từng đăng dưới tên nhóm.
       *
       * Không sợ trừ hai lần: `resolveAllForTarget` đóng mọi báo cáo còn mở của cùng một tin
       * trong một lượt, và lượt gọi thứ hai bị chặn ngay ở `status !== OPEN` phía trên.
       */
      trust = await applyTakedownPenalty(hidden, actor, before.status)

      // Người bán phải biết tin mình vừa biến mất vì sao — nhất là khi họ vừa bị trừ bậc. Bản
      // trước đi thẳng `setModerationStatus` nên bỏ qua `notifyPoster` mà bàn duyệt vẫn gọi.
      await notifyPoster(hidden, LISTING_STATUS.HIDDEN, `Bị báo cáo: ${report.kind}`)
    }

    await reportRepository.resolveAllForTarget(report.targetId, report.organizationId, {
      status: hideTarget ? REPORT_STATUS.RESOLVED : REPORT_STATUS.DISMISSED,
      resolution: {
        action: input.action,
        byUserId: new Types.ObjectId(actor.id),
        byName,
        at: new Date(),
      },
    })

    await recordAudit(
      { id: actor.id, name: byName },
      {
        action: hideTarget ? AUDIT_ACTION.REPORT_RESOLVE : AUDIT_ACTION.REPORT_DISMISS,
        // Đuôi uy tín chỉ xuất hiện khi lượt gỡ THẬT SỰ ghi án — in "bậc 0" cho lượt không phạt
        // là nói với quản trị nhóm rằng họ vừa hạ bậc ai đó, trong khi họ không có quyền đó.
        summary: hideTarget
          ? `Gỡ "${report.targetTitle}" sau báo cáo${trustNote(trust)}`
          : `Bỏ qua báo cáo về "${report.targetTitle}"`,
        targetType: 'report',
        targetId: report._id,
      },
      // Trục công khai (`null`) thì `recordAudit` chỉ ghi logger: `AuditLog` chưa dual-axis —
      // cùng hạng mục nợ trong v2-org-permission.plan.md, không phải việc của báo cáo.
      report.organizationId,
    )

    const updated = await reportRepository.findByIdForModeration(id)
    return toDto(updated!, 0)
  },
}
