import { ClientSession, Types } from 'mongoose'
import { Membership, IMembership, IMembershipDocument } from './membership.model'
import { MEMBERSHIP_STATUS, REPORT_TIMEZONE } from '../../common/constants'
import { PaginationParams } from '../../common/utils/pagination'

type Id = string | Types.ObjectId

const ACTIVE = { status: MEMBERSHIP_STATUS.ACTIVE }

export const membershipRepository = {
  /**
   * Thành viên MỚI theo cột thời gian của MỘT nhóm — anh em với `userRepository.reportSeries`,
   * nhưng đếm `joinedAt` của membership đang active chứ không phải ngày tạo tài khoản: với quản
   * trị nhóm, "người mới" là người mới VÀO NHÓM, dù tài khoản có từ năm ngoái. Người đã rời
   * (`archived`) không đếm — báo cáo trả lời "nhóm lớn thêm bao nhiêu", không phải "từng có ai".
   */
  reportSeries(organizationId: Id, from: Date, to: Date, format: string) {
    return Membership.aggregate<{ _id: string; users: number }>([
      {
        $match: {
          organizationId: new Types.ObjectId(organizationId),
          ...ACTIVE,
          joinedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format, date: '$joinedAt', timezone: REPORT_TIMEZONE } },
          users: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).exec()
  },

  /** Số thành viên đã ở trong nhóm TRƯỚC mốc `before` — điểm xuất phát của đường cộng dồn. */
  countJoinedBefore(organizationId: Id, before: Date): Promise<number> {
    return Membership.countDocuments({
      organizationId,
      ...ACTIVE,
      joinedAt: { $lt: before },
    }).exec()
  },

  create(data: Partial<IMembership>, session?: ClientSession) {
    return Membership.create([data], { session }).then(([doc]) => doc)
  },

  /** Chốt "người này có thuộc org đó không" — gọi trên mọi request có org scope. */
  findActive(userId: Id, organizationId: Id): Promise<IMembershipDocument | null> {
    return Membership.findOne({ userId, organizationId, ...ACTIVE }).exec()
  },

  listActiveByUser(userId: Id): Promise<IMembershipDocument[]> {
    return Membership.find({ userId, ...ACTIVE })
      .sort({ joinedAt: 1, _id: 1 })
      .exec()
  },

  /**
   * Đẩy mốc "đã xem hộp thư" của một người trong một nhóm — nguồn trạng thái đọc của thông báo
   * phát chung sinh tự động (xem `notification.model.ts` → `readBy`).
   *
   * Điều kiện `$lt` trong FILTER, không phải `$max` trong update: mốc chỉ được TIẾN, không lùi.
   * Thiếu nó thì bấm vào một thông báo cũ sẽ kéo mốc về quá khứ và mọi thông báo mới hơn lại
   * thành chưa đọc — người dùng thấy dấu chưa-đọc mọc lại sau khi vừa đọc.
   */
  markNotificationsSeen(userId: Id, organizationId: Id, at: Date) {
    return Membership.updateOne(
      {
        userId,
        organizationId,
        $or: [{ notificationsSeenAt: null }, { notificationsSeenAt: { $lt: at } }],
      },
      { $set: { notificationsSeenAt: at } },
    ).exec()
  },

  /**
   * Danh bạ của một org. Xếp theo `joinedAt` TĂNG dần: chủ tổ chức vào trước nên đứng đầu,
   * và thứ tự không nhảy mỗi lần có người mới như khi xếp giảm dần.
   */
  async paginateByOrganization(organizationId: Id, { skip, limit }: PaginationParams) {
    const filter = { organizationId, ...ACTIVE }
    const [items, total] = await Promise.all([
      Membership.find(filter).sort({ joinedAt: 1, _id: 1 }).skip(skip).limit(limit).exec(),
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
   * Gỡ MỘT người khỏi MỘT org — quản trị nhóm bấm "Gỡ khỏi nhóm".
   *
   * `archived` chứ không xoá, cùng lập luận với `archiveAllForUser` ngay dưới: danh bạ cũ và
   * `joinedAt` là dữ liệu của TỔ CHỨC. Người bị gỡ nhầm rồi thêm lại vẫn giữ được lịch sử, và
   * mọi đường đọc đã lọc `ACTIVE` sẵn nên chỉ đổi cột là họ biến khỏi danh bạ.
   *
   * Trả `null` khi không có bản ghi đang hoạt động — caller phân biệt được "đã gỡ rồi" với
   * "gỡ xong", thay vì báo thành công cho một thao tác không đụng vào gì.
   */
  archiveOne(userId: Id, organizationId: Id): Promise<IMembershipDocument | null> {
    return Membership.findOneAndUpdate(
      { userId, organizationId, ...ACTIVE },
      { status: MEMBERSHIP_STATUS.ARCHIVED, archivedAt: new Date() },
      { new: true },
    ).exec()
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
