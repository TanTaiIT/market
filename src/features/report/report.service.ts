import { Types } from 'mongoose'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { reportRepository } from './report.repository'
import { CreateReportInput, ReportQuery, ResolveReportInput } from './report.schema'
import { IReportDocument } from './report.model'
import { listingService } from '../listing/listing.service'
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
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { Grant } from '../../common/authz/policy'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

export interface ReportActor {
  id: string
  organizationId: string
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

/** Tên hiển thị của đối tượng bị báo cáo, snapshot ngay lúc gửi (§2.3 cấm populate). */
async function targetTitleOf(input: CreateReportInput): Promise<string> {
  if (input.targetType === REPORT_TARGET.LISTING) {
    const listing = await listingService.getById(input.targetId)

    /*
     * Chặn TƯỜNG MINH tin trục danh mục, cùng cách `chat.service.open` từ chối mở hội thoại
     * ở đó — `Report` là collection có tenant nên báo cáo sẽ rơi vào org của NGƯỜI BÁO CÁO,
     * còn tin thì thuộc người phụ trách danh mục. Hậu quả: ba org báo cáo cùng một tin sinh ra
     * ba hàng đợi rời nhau, và không ai trong số họ có thẩm quyền xử (`assertCanModerateListing`
     * chặn) — báo cáo gửi xong rơi vào hư không.
     *
     * Trả lỗi thay vì nhận rồi bỏ đó: hàng đợi báo cáo cho trục danh mục là việc còn nợ cùng
     * gói với `AuditLog` dual-axis (v2-org-permission.plan.md).
     */
    if (!listing.organizationId) {
      throw new BadRequestError('Chưa báo cáo được tin công khai ngoài tổ chức — sắp có')
    }
    return listing.title
  }
  const user = await userRepository.findById(input.targetId)
  if (!user) throw new NotFoundError('Không tìm thấy người dùng này')
  return user.name
}

export const reportService = {
  async create(input: CreateReportInput, actor: ReportActor) {
    if (input.targetId === actor.id) throw new BadRequestError('Không tự báo cáo chính mình')

    const [targetTitle, reporter] = await Promise.all([
      targetTitleOf(input),
      userRepository.findById(actor.id),
    ])
    if (!reporter) throw new NotFoundError('User not found')

    try {
      const report = await reportRepository.create({
        targetType: input.targetType,
        targetId: new Types.ObjectId(input.targetId),
        targetTitle,
        kind: input.kind,
        quote: input.quote,
        reporterId: reporter._id,
        // Snapshot này moderator của org đọc được — master báo cáo thì che tên thật, cùng
        // lý do với `audit_logs.actorName`.
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
  async resolve(id: string, input: ResolveReportInput, actor: ReportActor & { grants: Grant[] }) {
    const report = await reportRepository.findById(id)
    if (!report) throw new NotFoundError('Report not found')
    if (report.status !== REPORT_STATUS.OPEN) {
      throw new BadRequestError('Báo cáo này đã được xử lý rồi')
    }

    const moderator = await userRepository.findById(actor.id)
    const byName = moderator?.name ?? 'Quản trị'
    const hideTarget = input.action === 'hide_target' && report.targetType === REPORT_TARGET.LISTING
    /** Bậc uy tín sau khi trừ — chỉ có khi báo cáo được xác minh. Dùng cho dòng nhật ký. */
    let trust: TrustState | null = null

    if (hideTarget) {
      // `grants` là bắt buộc: `setModerationStatus` tự chốt phạm vi duyệt theo TRỤC của tin,
      // nên báo cáo về một tin trục danh mục sẽ bị 403 ở đây thay vì để quyền org ẩn nó.
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

    await reportRepository.resolveAllForTarget(report.targetId, {
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
      // Báo cáo LUÔN thuộc một org (`Report` là collection có tenant, không dual-axis), nên
      // vết của nó không bao giờ rơi vào nhánh "trục danh mục" của `recordAudit`.
      report.organizationId,
    )

    const updated = await reportRepository.findById(id)
    return toDto(updated!, 0)
  },
}
