import { Types } from 'mongoose'
import { JoinRequest, IJoinRequest, IJoinRequestDocument } from './join-request.model'
import { JOIN_REQUEST_STATUS } from '../../common/constants'

type Id = string | Types.ObjectId

export const joinRequestRepository = {
  create(data: Partial<IJoinRequest>) {
    return JoinRequest.create(data)
  },

  findById(id: Id): Promise<IJoinRequestDocument | null> {
    return JoinRequest.findOne({ _id: id }).exec()
  },

  listByOrganization(organizationId: Id, status?: string): Promise<IJoinRequestDocument[]> {
    const filter: Record<string, unknown> = { organizationId }
    if (status) filter.status = status
    return JoinRequest.find(filter).sort({ createdAt: -1 }).exec()
  },

  listByUser(userId: Id): Promise<IJoinRequestDocument[]> {
    return JoinRequest.find({ userId }).sort({ createdAt: -1 }).exec()
  },

  countPendingByUser(userId: Id) {
    return JoinRequest.countDocuments({ userId, status: JOIN_REQUEST_STATUS.PENDING }).exec()
  },

  /** Đơn bị từ chối gần nhất ở org này — nguồn của cooldown chống spam gửi lại. */
  latestRejected(userId: Id, organizationId: Id): Promise<IJoinRequestDocument | null> {
    return JoinRequest.findOne({
      userId,
      organizationId,
      status: JOIN_REQUEST_STATUS.REJECTED,
    })
      .sort({ reviewedAt: -1 })
      .exec()
  },

  updateById(id: Id, update: Partial<IJoinRequest>) {
    return JoinRequest.findOneAndUpdate({ _id: id }, update, { new: true }).exec()
  },

  /**
   * Đơn quá hạn chuyển sang `expired` ngay khi có người mở hàng đợi, thay vì chờ một job nền
   * chưa tồn tại. Rẻ (một `updateMany` có index) và giữ trạng thái đọc được luôn đúng.
   */
  expireStale(now: Date) {
    return JoinRequest.updateMany(
      { status: JOIN_REQUEST_STATUS.PENDING, expiresAt: { $lt: now } },
      { status: JOIN_REQUEST_STATUS.EXPIRED, reviewedAt: now },
    ).exec()
  },
}
