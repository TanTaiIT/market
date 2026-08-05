import { userRepository } from './user.repository'
import { UpdateProfileInput } from './user.schema'
import { NotFoundError, ConflictError } from '../../common/errors'
import { IUser } from './user.model'

export const userService = {
  async getById(id: string) {
    const user = await userRepository.findById(id)
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async createUser(data: Partial<IUser>) {
    if (data.email && (await userRepository.existsByEmail(data.email))) {
      throw new ConflictError('Email already registered')
    }
    return userRepository.create(data)
  },

  async updateProfile(id: string, update: UpdateProfileInput) {
    const user = await userRepository.updateById(id, update)
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async deleteAccount(id: string) {
    const user = await userRepository.softDelete(id)
    if (!user) throw new NotFoundError('User not found')
    return user
  },
}
