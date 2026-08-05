import { User, IUserDocument, IUser } from './user.model'

/**
 * Tách toàn bộ truy vấn DB khỏi service để dễ test/thay tầng lưu trữ.
 */
export const userRepository = {
  create(data: Partial<IUser>) {
    return User.create(data)
  },

  findById(id: string, opts: { withPassword?: boolean } = {}) {
    const query = User.findById(id)
    if (opts.withPassword) query.select('+password')
    return query
  },

  findByEmail(email: string, opts: { withPassword?: boolean } = {}) {
    const query = User.findOne({ email: email.toLowerCase() })
    if (opts.withPassword) query.select('+password')
    return query
  },

  existsByEmail(email: string) {
    return User.exists({ email: email.toLowerCase() })
  },

  updateById(id: string, update: Partial<IUser>) {
    return User.findByIdAndUpdate(id, update, { new: true, runValidators: true })
  },

  softDelete(id: string): Promise<IUserDocument | null> {
    return User.findByIdAndUpdate(
      id,
      { deletedAt: new Date(), isActive: false },
      { new: true },
    ).exec()
  },
}
