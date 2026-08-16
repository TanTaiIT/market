import { Types } from 'mongoose'
import { reportRepository } from './report.repository'
import { CreateReportInput, ReportQuery, ResolveReportInput } from './report.schema'
import { IReportDocument } from './report.model'
import { listingService } from '../listing/listing.service'
import { userRepository } from '../user/user.repository'
import { recordAudit } from '../moderation/moderation.service'
import { AUDIT_ACTION, LISTING_STATUS, REPORT_STATUS, REPORT_TARGET } from '../../common/constants'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
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
        reporterName: reporter.name,
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
  async resolve(id: string, input: ResolveReportInput, actor: ReportActor) {
    const report = await reportRepository.findById(id)
    if (!report) throw new NotFoundError('Report not found')
    if (report.status !== REPORT_STATUS.OPEN) {
      throw new BadRequestError('Báo cáo này đã được xử lý rồi')
    }

    const moderator = await userRepository.findById(actor.id)
    const byName = moderator?.name ?? 'Quản trị'
    const hideTarget = input.action === 'hide_target' && report.targetType === REPORT_TARGET.LISTING

    if (hideTarget) {
      await listingService.setModerationStatus(report.targetId.toString(), {
        status: LISTING_STATUS.HIDDEN,
        reason: `Bị báo cáo: ${report.kind}`,
        byUserId: actor.id,
        byName,
      })
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
      { id: actor.id, name: byName, organizationId: actor.organizationId },
      {
        action: hideTarget ? AUDIT_ACTION.REPORT_RESOLVE : AUDIT_ACTION.REPORT_DISMISS,
        summary: hideTarget
          ? `Gỡ "${report.targetTitle}" sau báo cáo`
          : `Bỏ qua báo cáo về "${report.targetTitle}"`,
        targetType: 'report',
        targetId: report._id,
      },
    )

    const updated = await reportRepository.findById(id)
    return toDto(updated!, 0)
  },
}
