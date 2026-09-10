import { ClientSession, FilterQuery, Types } from 'mongoose'
import { User, IUserDocument, IUser } from './user.model'
import { REPORT_TIMEZONE } from '../../common/constants'
import { runUnscoped } from '../../common/tenant/tenantContext'

/**
 * Tài khoản là toàn cục nên repository này KHÔNG còn nhận `organizationId`. Ranh giới tenant
 * chuyển sang `memberships` — đó là nơi trả lời "người này có thuộc org đó không", và
 * `tenantPlugin` vẫn gác mọi collection nghiệp vụ như cũ.
 */
export const userRepository = {
  async create(
    data: Partial<IUser> & { _id?: Types.ObjectId },
    session?: ClientSession,
  ): Promise<IUserDocument> {
    const [user] = await User.create([data], { session })
    return user
  },

  findById(id: string | Types.ObjectId, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ _id: id })
    if (opts.withPassword) query.select('+password')
    return query
  },

  /** Đọc theo lô cho danh bạ/danh sách — user đã xoá mềm tự rơi khỏi kết quả nhờ hook của model. */
  findByIds(ids: Types.ObjectId[]) {
    return User.find({ _id: { $in: ids } }).exec()
  },

  /**
   * Tra theo số điện thoại. Trả về MẢNG chứ không phải một document: `phone` không unique và
   * không index (`user.model.ts` nói rõ), nên hai tài khoản trùng số là hợp lệ. Caller phải tự
   * quyết định làm gì khi ra nhiều hơn một — đoán bừa là mời nhầm người.
   */
  findByPhone(phone: string) {
    return User.find({ phone }).limit(5).exec()
  },

  findByEmail(email: string, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ email: email.toLowerCase() })
    if (opts.withPassword) query.select('+password')
    return query
  },

  existsByEmail(email: string) {
    return User.exists({ email: email.toLowerCase(), deletedAt: null })
  },

  /**
   * Bảng người dùng cho master. `q` neo đầu trên `email` (có index); vế `name` là quét — chấp
   * nhận được vì đây là màn quản trị ít gọi, không phải đường nóng.
   */
  async paginateAdmin(
    filters: { q?: string; status?: 'active' | 'locked'; excludeIds?: Types.ObjectId[] },
    { skip, limit }: { skip: number; limit: number },
  ) {
    const filter: FilterQuery<IUserDocument> = {}
    if (filters.excludeIds?.length) filter._id = { $nin: filters.excludeIds }
    if (filters.status) filter.isActive = filters.status === 'active'
    if (filters.q) {
      // Người dùng gõ gì thì tìm đúng cái đó — một dấu `.` trong email không phải wildcard.
      const escaped = filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { email: { $regex: `^${escaped}`, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
      ]
    }

    const [items, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      User.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  /**
   * Số tài khoản MỚI theo từng cột thời gian, gộp trong múi giờ thị trường.
   *
   * `runUnscoped` + `deletedAt: null` khai tay: `aggregate` không đi qua hook
   * `pre(/^find/)` của soft-delete, và `User` mang `tenantPlugin` nên thiếu scope là ném.
   * Chỉ master gọi được (`requireMaster` ở route) và kết quả là con số gộp, không lộ tài khoản nào.
   *
   * Tài khoản đã xoá KHÔNG được đếm: báo cáo này trả lời "sàn lớn thêm bao nhiêu người", mà
   * một người đã rời đi thì không còn là tăng trưởng — đếm họ là tự khen mình bằng số cũ.
   */
  reportSeries(from: Date, to: Date, format: string) {
    return runUnscoped('report: người dùng mới theo thời gian', () =>
      User.aggregate<{ _id: string; users: number }>([
        { $match: { deletedAt: null, createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateToString: { format, date: '$createdAt', timezone: REPORT_TIMEZONE } },
            users: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
    )
  },

  /**
   * Số tài khoản còn sống được tạo TRƯỚC mốc `before` — điểm xuất phát của đường cộng dồn.
   *
   * Không có nó thì cột đầu tiên của biểu đồ bắt đầu từ 0 và người đọc tưởng sàn mới có người
   * từ đầu cửa sổ báo cáo.
   */
  countCreatedBefore(before: Date): Promise<number> {
    return runUnscoped('report: số người dùng trước mốc bắt đầu', () =>
      User.countDocuments({ deletedAt: null, createdAt: { $lt: before } }).exec(),
    )
  },

  updateById(id: string | Types.ObjectId, update: Partial<IUser>) {
    return User.findOneAndUpdate({ _id: id }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },

  /**
   * Bao nhiêu người trong danh sách này còn ĐĂNG NHẬP ĐƯỢC — `deletedAt` do hook
   * `pre('countDocuments')` của model lo, ở đây chỉ còn điều kiện `isActive` mà `auth.service`
   * dùng để từ chối đăng nhập. Xem `roleGrantService` §5.4 cho lý do phép đếm này tồn tại.
   */
  countUsable(ids: Types.ObjectId[]): Promise<number> {
    if (ids.length === 0) return Promise.resolve(0)
    return User.countDocuments({ _id: { $in: ids }, isActive: true }).exec()
  },

  softDelete(id: string | Types.ObjectId): Promise<IUserDocument | null> {
    return User.findOneAndUpdate(
      { _id: id },
      { deletedAt: new Date(), isActive: false },
      { new: true },
    ).exec()
  },

  /**
   * Xoá avatar bị máy kiểm ảnh từ chối (webhook `moderation.webhook.service.ts`) — về rỗng,
   * FE rơi về chữ viết tắt. User không có tenantPlugin nên không cần `runUnscoped`.
   */
  async clearAvatarRef(pattern: RegExp): Promise<number> {
    const res = await User.updateMany({ avatar: pattern }, { avatar: '' }).exec()
    return res.modifiedCount
  },

  /** Avatar của mọi tài khoản — cho job dọn ảnh mồ côi (`upload.cleanup.service.ts`). */
  async allAvatars(): Promise<string[]> {
    const rows = await User.find().select('avatar').lean().exec()
    return rows.map((r) => r.avatar)
  },
}
