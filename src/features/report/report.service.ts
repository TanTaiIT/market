import { Types } from 'mongoose'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { reportRepository } from './report.repository'
import { CreateReportInput, ReportQuery, ResolveReportInput } from './report.schema'
import { IReport, IReportDocument } from './report.model'
import { assertCanModerateListing, listingService } from '../listing/listing.service'
import { trustRepository } from '../trust/trust.repository'
import type { TrustState } from '../trust/trust.policy'
import { userRepository } from '../user/user.repository'
import { recordAudit } from '../moderation/moderation.service'
import {
  AUDIT_ACTION,
  LISTING_STATUS,
  MASTER_DISPLAY_NAME,
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
 *   xử, master là fallback — đúng luật của hàng đợi duyệt (`assertCanModerateListing`).
 *
 * Báo cáo về NGƯỜI không có trục tự nhiên: đóng dấu org người tố đang đứng (như trước), không
 * có org thì lên trục công khai và chỉ master xử (xem `assertCanResolve`).
 *
 * `getById` chạy trong scope của người tố nên tin họ không đọc được (tin nội bộ của org khác,
 * tin công khai chưa duyệt) là 404 ngay ở đây — không báo cáo được thứ mình không thấy.
 */
async function targetOf(input: CreateReportInput): Promise<ReportTarget> {
  if (input.targetType === REPORT_TARGET.LISTING) {
    const listing = await listingService.getById(input.targetId)
    const isPublic = !listing.organizationId
    return {
      targetTitle: listing.title,
      organizationId: listing.organizationId ?? null,
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
 * Thẩm quyền đóng MỘT báo cáo, theo trục của nó — đối xứng với `assertCanModerateListing`.
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
    assertCanModerateListing(listing, grants)
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
      targetOf(input),
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
       * Uy tín trừ ở ĐÂY chứ không ở `applyTrustEffect`.
       *
       * `applyTrustEffect` cố tình bỏ qua trạng thái `hidden`: ẩn tin là thao tác vận hành,
       * có thể vì lý do ngoài lỗi người đăng. Nhưng ẩn vì một báo cáo ĐÃ ĐƯỢC XÁC MINH thì
       * khác hẳn — đó là kết luận "người này làm sai", và là loại vi phạm nguy hiểm nhất:
       * tin đã lọt qua kiểm duyệt, đã tới tay người mua, rồi mới bị chính họ tố giác.
       *
       * Không sợ trừ hai lần: `resolveAllForTarget` đóng mọi báo cáo còn mở của cùng một tin
       * trong một lượt, và lượt gọi thứ hai bị chặn ngay ở `status !== OPEN` phía trên.
       */
      trust = await trustRepository.record(hidden.seller, false)
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
        summary: hideTarget
          ? `Gỡ "${report.targetTitle}" sau báo cáo · uy tín bậc ${trust?.level ?? 0}`
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
