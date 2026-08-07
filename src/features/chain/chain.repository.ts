import { Types } from 'mongoose'
import { Chain, IChain, IChainDocument } from './chain.model'
import { TENANT_STATUS } from '../../common/constants'

export const chainRepository = {
  create(data: Partial<IChain>) {
    return Chain.create(data)
  },

  findActiveById(id: string | Types.ObjectId): Promise<IChainDocument | null> {
    return Chain.findOne({ _id: id, status: TENANT_STATUS.ACTIVE, deletedAt: null }).exec()
  },

  existsBySlug(slug: string) {
    return Chain.exists({ slug: slug.toLowerCase(), deletedAt: null })
  },

  updateById(id: string | Types.ObjectId, update: Partial<IChain>) {
    return Chain.findOneAndUpdate({ _id: id, deletedAt: null }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },
}
