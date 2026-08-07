import { ClientSession, Types } from 'mongoose'
import { User, IUserDocument, IUser } from './user.model'

type OrgId = string | Types.ObjectId

/**
 * Tách toàn bộ truy vấn DB khỏi service để dễ test/thay tầng lưu trữ.
 *
 * `organizationId` là tham số BẮT BUỘC ở mọi method chứ không optional: User không đi
 * qua tenantPlugin (login phải tìm user trước khi có context), nên đây là chỗ duy nhất
 * giữ ranh giới tenant — optional hoá nó là mở đường cho một query quên filter.
 */
export const userRepository = {
  async create(
    data: Partial<IUser> & { _id?: Types.ObjectId },
    session?: ClientSession,
  ): Promise<IUserDocument> {
    const [user] = await User.create([data], { session })
    return user
  },

  findById(id: string, organizationId: OrgId, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ _id: id, organizationId })
    if (opts.withPassword) query.select('+password')
    return query
  },

  findByEmail(email: string, organizationId: OrgId, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ email: email.toLowerCase(), organizationId })
    if (opts.withPassword) query.select('+password')
    return query
  },

  existsByEmail(email: string, organizationId: OrgId) {
    return User.exists({ email: email.toLowerCase(), organizationId, deletedAt: null })
  },

  updateById(id: string, organizationId: OrgId, update: Partial<IUser>) {
    return User.findOneAndUpdate({ _id: id, organizationId }, update, {
      new: true,
      runValidators: true,
    })
  },

  softDelete(id: string, organizationId: OrgId): Promise<IUserDocument | null> {
    return User.findOneAndUpdate(
      { _id: id, organizationId },
      { deletedAt: new Date(), isActive: false },
      { new: true },
    ).exec()
  },

  /** Dùng cho thống kê chain — org nào cũng nằm trong scope đọc đã được middleware xác thực. */
  countByOrganizations(orgIds: Types.ObjectId[]) {
    return User.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { organizationId: { $in: orgIds }, deletedAt: null } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ])
  },
}
