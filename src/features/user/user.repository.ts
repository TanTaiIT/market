import { ClientSession, Types } from 'mongoose'
import { User, IUserDocument, IUser } from './user.model'

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

  findByEmail(email: string, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ email: email.toLowerCase() })
    if (opts.withPassword) query.select('+password')
    return query
  },

  existsByEmail(email: string) {
    return User.exists({ email: email.toLowerCase(), deletedAt: null })
  },

  updateById(id: string | Types.ObjectId, update: Partial<IUser>) {
    return User.findOneAndUpdate({ _id: id }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },

  softDelete(id: string | Types.ObjectId): Promise<IUserDocument | null> {
    return User.findOneAndUpdate(
      { _id: id },
      { deletedAt: new Date(), isActive: false },
      { new: true },
    ).exec()
  },
}
