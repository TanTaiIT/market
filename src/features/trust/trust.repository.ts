import { Types } from 'mongoose'
import { PublicTrust, IPublicTrustDocument } from './trust.model'

type Id = string | Types.ObjectId

export const trustRepository = {
  find(userId: Id, categoryId: Id): Promise<IPublicTrustDocument | null> {
    return PublicTrust.findOne({ userId, categoryId }).exec()
  },

  async levelOf(userId: Id, categoryId: Id): Promise<number> {
    const doc = await this.find(userId, categoryId)
    return doc?.level ?? 0
  },

  /** Bài sạch cộng dồn; đủ ngưỡng thì thăng bậc. Upsert vì bậc 0 không cần bản ghi. */
  recordApproval(userId: Id, categoryId: Id, promoteEvery: number) {
    return PublicTrust.findOneAndUpdate(
      { userId, categoryId },
      { $inc: { cleanApprovals: 1 } },
      { new: true, upsert: true },
    )
      .exec()
      .then(async (doc) => {
        const nextLevel = Math.floor(doc.cleanApprovals / promoteEvery)
        if (nextLevel === doc.level) return doc
        return PublicTrust.findOneAndUpdate(
          { _id: doc._id },
          { level: nextLevel },
          { new: true },
        ).exec()
      })
  },

  /** Bị từ chối là mất chuỗi bài sạch và tụt một bậc — không xoá trắng lịch sử. */
  recordRejection(userId: Id, categoryId: Id) {
    return PublicTrust.findOneAndUpdate(
      { userId, categoryId },
      { $set: { cleanApprovals: 0 }, $inc: { level: -1 } },
      { new: true, upsert: true },
    )
      .exec()
      .then((doc) =>
        doc.level < 0
          ? PublicTrust.findOneAndUpdate({ _id: doc._id }, { level: 0 }, { new: true }).exec()
          : doc,
      )
  },
}
