import { ClientSession, Types } from 'mongoose'
import { Membership, IMembership, IMembershipDocument } from './membership.model'
import { MEMBERSHIP_STATUS } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'

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

  /**
   * Danh bạ của một org. Xếp theo `joinedAt` TĂNG dần: chủ tổ chức vào trước nên đứng đầu,
   * và thứ tự không nhảy mỗi lần có người mới như khi xếp giảm dần.
   */
  async paginateByOrganization(organizationId: Id, { skip, limit }: PaginationParams) {
    const filter = { organizationId, ...ACTIVE }
    const [items, total] = await Promise.all([
      Membership.find(filter).sort({ joinedAt: 1 }).skip(skip).limit(limit).exec(),
      Membership.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  countActiveByOrganization(organizationId: Id) {
    return Membership.countDocuments({ organizationId, ...ACTIVE }).exec()
  },

  /**
   * Lưu trữ mọi tư cách thành viên của một người, dùng khi tài khoản bị xoá.
   *
   * Không xoá bản ghi: danh bạ cũ và `joinedAt` là dữ liệu của TỔ CHỨC, không phải của tài
   * khoản — org vẫn cần biết người này từng thuộc nhóm nào. `archived` là trạng thái mà mọi
   * đường đọc đã lọc sẵn (`ACTIVE`), nên chỉ cần đổi cột là họ biến khỏi danh bạ.
   */
  archiveAllForUser(userId: Id) {
    return Membership.updateMany(
      { userId, ...ACTIVE },
      { status: MEMBERSHIP_STATUS.ARCHIVED, archivedAt: new Date() },
    ).exec()
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
