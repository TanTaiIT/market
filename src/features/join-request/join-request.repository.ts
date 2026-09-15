import { Types } from 'mongoose'
import { JoinRequest, IJoinRequest, IJoinRequestDocument } from './join-request.model'
import { JOIN_REQUEST_STATUS } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'

type Id = string | Types.ObjectId

export const joinRequestRepository = {
  create(data: Partial<IJoinRequest>) {
    return JoinRequest.create(data)
  },

  findById(id: Id): Promise<IJoinRequestDocument | null> {
    return JoinRequest.findOne({ _id: id }).exec()
  },

  /**
   * Phân trang chứ không trả hết: hàng đợi đơn của một trường 2.000 học sinh đầu năm là hàng
   * trăm dòng, mà màn duyệt chỉ vẽ được mười dòng đầu.
   */
  async paginateByOrganization(
    organizationId: Id,
    status: string | undefined,
    { skip, limit }: PaginationParams,
  ) {
    const filter: Record<string, unknown> = { organizationId }
    if (status) filter.status = status
    const [items, total] = await Promise.all([
      JoinRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).exec(),
      JoinRequest.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  listByUser(userId: Id): Promise<IJoinRequestDocument[]> {
    return JoinRequest.find({ userId }).sort({ createdAt: -1, _id: -1 }).exec()
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

  /**
   * Đơn đang chờ của một người ở một org — nhiều nhất một bản (unique index partial trên
   * `status: pending`). Dùng cho nhánh vào-ngay: có đơn cũ thì DUYỆT chính nó thay vì đẻ bản
   * thứ hai, kẻo hàng đợi của nhóm treo một đơn cho người đã là thành viên.
   */
  findPendingFor(userId: Id, organizationId: Id): Promise<IJoinRequestDocument | null> {
    return JoinRequest.findOne({
      userId,
      organizationId,
      status: JOIN_REQUEST_STATUS.PENDING,
    }).exec()
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
