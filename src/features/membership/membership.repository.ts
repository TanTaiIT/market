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

  /**
   * Đếm thành viên của NHIỀU org trong một lượt — danh sách nhóm cần con số cho từng dòng.
   * Đếm lẻ từng org là N+1 ngay giữa đường người dùng đang gõ tìm kiếm.
   */
  async countActiveByOrganizations(ids: Types.ObjectId[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map()
    const rows = await Membership.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { organizationId: { $in: ids }, ...ACTIVE } },
      { $group: { _id: '$organizationId', n: { $sum: 1 } } },
    ]).exec()
    return new Map(rows.map((r) => [r._id.toString(), r.n]))
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
}
