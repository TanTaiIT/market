import { Types } from 'mongoose'
import { Report, IReport, IReportDocument } from './report.model'
import { REPORT_STATUS, ReportStatus } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'
import { runUnscoped } from '../../common/tenant/tenantContext'

export const reportRepository = {
  /**
   * Ghi với `organizationId` TƯỜNG MINH — org của TIN, hoặc `null` cho trục công khai — và chạy
   * unscoped. Để plugin so với scope thì thành viên hai nhóm đang đứng ở nhóm A báo cáo tin của
   * nhóm B là `CrossTenantWriteError`, trong khi đó là đúng việc. Quyền ĐỌC tin (tức quyền báo
   * cáo nó) đã được `listingService.getById` kiểm trước đó, trong scope của người tố.
   */
  create(data: Partial<IReport> & { organizationId: Types.ObjectId | null }) {
    return runUnscoped('report: đóng dấu trục của TIN, không phải org của người tố', () =>
      Report.create(data),
    )
  },

  /**
   * Đọc một báo cáo để XÉT THẨM QUYỀN — unscoped, cùng lý do với
   * `listingService.getForModeration`: người phụ trách danh mục không có org trong scope nên bản
   * có scope trả 404 trước khi ai kịp xét quyền. Caller BẮT BUỘC đưa nó qua `assertCanResolve`
   * trước khi làm gì với nó.
   */
  findByIdForModeration(id: string) {
    return runUnscoped('report: đọc để xét thẩm quyền theo trục', () => Report.findById(id).exec())
  },

  countOpen() {
    return Report.countDocuments({ status: REPORT_STATUS.OPEN })
  },

  async paginate(status: ReportStatus | undefined, { skip, limit }: PaginationParams) {
    const filter = status ? { status } : {}
    const [items, total] = await Promise.all([
      // Báo cáo nặng lên trước không làm được bằng index, nên sắp theo thời gian và để
      // service gom nhóm — hàng đợi vài chục bản ghi, không đáng thêm field ưu tiên.
      Report.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
      Report.countDocuments(filter),
    ])
    return { items, total }
  },

  /** Đếm số lượt báo cáo còn mở theo từng đối tượng — nguồn của con số "N lượt báo cáo". */
  async countsByTarget(targetIds: Types.ObjectId[]) {
    const rows = await Report.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { targetId: { $in: targetIds }, status: REPORT_STATUS.OPEN } },
      { $group: { _id: '$targetId', count: { $sum: 1 } } },
    ])
    return new Map(rows.map((row) => [row._id.toString(), row.count]))
  },

  /**
   * Đóng mọi báo cáo còn mở của cùng một đối tượng. Xử một tin bị 3 người báo cáo phải đóng
   * cả ba, nếu không hàng đợi vẫn còn hai bản ghi về việc đã giải quyết xong.
   *
   * Unscoped + lọc `organizationId` tường minh, vì thẩm quyền đã xét ở service theo trục của
   * báo cáo: master đóng báo cáo của một org từ danh sách xuyên tổ chức (không kèm `X-Org-Slug`)
   * thì scope không có org đó — để plugin lọc là `updateMany` khớp 0 dòng, và báo cáo "đã xử"
   * vẫn nằm mở trong hàng đợi.
   */
  resolveAllForTarget(
    targetId: Types.ObjectId,
    organizationId: Types.ObjectId | null,
    update: Partial<IReportDocument>,
  ) {
    return runUnscoped('report: đóng theo đối tượng, thẩm quyền đã xét theo trục ở service', () =>
      Report.updateMany({ targetId, organizationId, status: REPORT_STATUS.OPEN }, update).exec(),
    )
  },
}
