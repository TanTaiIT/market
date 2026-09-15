import { Types } from 'mongoose'
import { SocialFeedback } from './social-feedback.model'
import { SocialFeedbackStatus } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'

export const socialFeedbackRepository = {
  create(input: { orgName: string; decisionNo: string; content: string }) {
    return SocialFeedback.create(input)
  },

  /**
   * Một trang theo trạng thái. `status` là tham số BẮT BUỘC, không optional như
   * `reportRepository.paginate`: cả hai người gọi đều biết mình muốn trạng thái nào, và một
   * mặc định "tất cả" ở đây là cách trang công bố vô tình trả cả hàng chờ duyệt.
   */
  async paginate(status: SocialFeedbackStatus, { skip, limit }: PaginationParams) {
    const filter = { status }
    const [items, total] = await Promise.all([
      SocialFeedback.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).exec(),
      SocialFeedback.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  setStatus(id: string, status: SocialFeedbackStatus, reviewedBy: Types.ObjectId) {
    return SocialFeedback.findByIdAndUpdate(
      id,
      { status, reviewedBy, reviewedAt: new Date() },
      { new: true },
    ).exec()
  },
}
