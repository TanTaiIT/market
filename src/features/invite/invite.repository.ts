import { Types } from 'mongoose'
import { Invite, IInvite, IInviteDocument } from './invite.model'
import { INVITE_STATUS } from '../../common/constants'

type Id = string | Types.ObjectId

/**
 * `Invite` đứng ngoài `tenantPlugin`, nên mọi method ở đây nhận `organizationId` TƯỜNG MINH —
 * ép bằng kiểu thay vì dựa vào kỷ luật của người viết query sau này (mt§1.3).
 */
export const inviteRepository = {
  create(data: Partial<IInvite>) {
    return Invite.create(data)
  },

  findById(id: string) {
    return Invite.findById(id).exec()
  },

  /** Đường vào của người bấm link — không có org scope nào ở thời điểm này. */
  findByTokenHash(tokenHash: string): Promise<IInviteDocument | null> {
    return Invite.findOne({ tokenHash }).exec()
  },

  listByOrganization(organizationId: Id) {
    return Invite.find({ organizationId }).sort({ createdAt: -1 }).limit(200).exec()
  },

  /** Hộp thư lời mời của một người: chỉ lời mời đích danh, chỉ cái còn hiệu lực. */
  listPendingForUser(userId: Id) {
    return Invite.find({ invitedUserId: userId, status: INVITE_STATUS.PENDING })
      .sort({ createdAt: -1 })
      .exec()
  },

  /**
   * Đánh dấu hết hạn theo lô, gọi trước mỗi lượt đọc danh sách.
   *
   * Không dùng TTL index: TTL XOÁ bản ghi, mà admin cần thấy "đã mời người này, họ không trả
   * lời" — mất dấu vết đó là mời lại lần thứ ba mà không biết mình đã mời hai lần.
   */
  expireStale(now: Date) {
    return Invite.updateMany(
      { status: INVITE_STATUS.PENDING, expiresAt: { $lt: now } },
      { $set: { status: INVITE_STATUS.EXPIRED } },
    ).exec()
  },
}
