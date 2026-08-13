import { Types } from 'mongoose'
import { Report, IReport, IReportDocument } from './report.model'
import { REPORT_STATUS, ReportStatus } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'

export const reportRepository = {
  create(data: Partial<IReport>) {
    return Report.create(data)
  },

  findById(id: string) {
    return Report.findById(id)
  },

  countOpen() {
    return Report.countDocuments({ status: REPORT_STATUS.OPEN })
  },

  async paginate(status: ReportStatus | undefined, { skip, limit }: PaginationParams) {
    const filter = status ? { status } : {}
    const [items, total] = await Promise.all([
      // Báo cáo nặng lên trước không làm được bằng index, nên sắp theo thời gian và để
      // service gom nhóm — hàng đợi vài chục bản ghi, không đáng thêm field ưu tiên.
      Report.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
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

  updateById(id: string, update: Partial<IReportDocument>) {
    return Report.findByIdAndUpdate(id, update, { new: true }).exec()
  },

  /**
   * Đóng mọi báo cáo còn mở của cùng một đối tượng. Xử một tin bị 3 người báo cáo phải đóng
   * cả ba, nếu không hàng đợi vẫn còn hai bản ghi về việc đã giải quyết xong.
   */
  resolveAllForTarget(targetId: Types.ObjectId, update: Partial<IReportDocument>) {
    return Report.updateMany({ targetId, status: REPORT_STATUS.OPEN }, update).exec()
  },
}
