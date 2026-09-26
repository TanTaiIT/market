import { Types } from 'mongoose'
import { SocialFeedback } from './social-feedback.model'
import { SocialFeedbackStatus, SOCIAL_FEEDBACK_STATUS } from '../../common/constants'
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

  findById(id: string) {
    return SocialFeedback.findById(id).exec()
  },

  /** Chỉ xử được ý kiến ĐANG CHỜ (audit 2.7): công bố rồi lại từ chối, hay ngược lại, là hai quyết định chồng nhau không ai giải thích được. */
  setStatus(id: string, status: SocialFeedbackStatus, reviewedBy: Types.ObjectId) {
    return SocialFeedback.findOneAndUpdate(
      { _id: id, status: SOCIAL_FEEDBACK_STATUS.PENDING },
      { status, reviewedBy, reviewedAt: new Date() },
      { new: true },
    ).exec()
  },
}
