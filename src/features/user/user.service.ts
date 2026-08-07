import { Types } from 'mongoose'
import { userRepository } from './user.repository'
import { UpdateProfileInput } from './user.schema'
import { NotFoundError } from '../../common/errors'
import { requireScope } from '../../common/tenant/tenantContext'

/** User nằm ngoài tenantPlugin nên mọi lối vào phải tự mang org — lấy từ scope, không từ client. */
function scopedOrgId(): Types.ObjectId {
  const scope = requireScope('user')
  if (!scope.ownOrgId) throw new NotFoundError('User not found')
  return scope.ownOrgId
}

export const userService = {
  async getById(id: string) {
    const user = await userRepository.findById(id, scopedOrgId())
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async updateProfile(id: string, update: UpdateProfileInput) {
    const user = await userRepository.updateById(id, scopedOrgId(), update)
    if (!user) throw new NotFoundError('User not found')
    return user
  },

  async deleteAccount(id: string) {
    const user = await userRepository.softDelete(id, scopedOrgId())
    if (!user) throw new NotFoundError('User not found')
    return user
  },
}
