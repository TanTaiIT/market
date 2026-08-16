import { ClientSession, Types } from 'mongoose'
import { Membership, IMembership, IMembershipDocument } from './membership.model'
import { MEMBERSHIP_STATUS } from '../../common/constants'

type Id = string | Types.ObjectId

const ACTIVE = { status: MEMBERSHIP_STATUS.ACTIVE }

export const membershipRepository = {
  create(data: Partial<IMembership>, session?: ClientSession) {
    return Membership.create([data], { session }).then(([doc]) => doc)
  },

  /** Chốt "người này có thuộc org đó không" — gọi trên mọi request có org scope. */
  findActive(userId: Id, organizationId: Id): Promise<IMembershipDocument | null> {
    return Membership.findOne({ userId, organizationId, ...ACTIVE }).exec()
  },

  listActiveByUser(userId: Id): Promise<IMembershipDocument[]> {
    return Membership.find({ userId, ...ACTIVE })
      .sort({ joinedAt: 1 })
      .exec()
  },

  countActiveByOrganization(organizationId: Id) {
    return Membership.countDocuments({ organizationId, ...ACTIVE }).exec()
  },

  /**
   * Thăng/giáng uy tín trong org. Đếm bài sạch cộng dồn thay vì cộng thẳng vào `trustLevel`:
   * "5 bài sạch mới lên một bậc" phải đo được, và một lần bị từ chối phải xoá được chuỗi đó.
   */
  async adjustTrust(
    userId: Id,
    organizationId: Id,
    opts: { approved: boolean; promoteEvery: number },
  ) {
    const membership = await Membership.findOne({ userId, organizationId }).exec()
    if (!membership) return null

    if (!opts.approved) {
      membership.cleanApprovals = 0
      membership.trustLevel = Math.max(0, membership.trustLevel - 1)
      return membership.save()
    }

    membership.cleanApprovals += 1
    membership.trustLevel = Math.floor(membership.cleanApprovals / opts.promoteEvery)
    return membership.save()
  },
}
