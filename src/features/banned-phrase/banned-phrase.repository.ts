import { Types } from 'mongoose'
import { BannedPhrase } from './banned-phrase.model'

export const bannedPhraseRepository = {
  /** Cả từ điển, mới nhất trước — danh sách cỡ chục dòng, không cần phân trang. */
  listAll() {
    return BannedPhrase.find().sort({ createdAt: -1 }).exec()
  },

  /** Chỉ phần chữ, cho cache của service — mọi điểm so khớp chỉ cần mảng string. */
  async allPhrases(): Promise<string[]> {
    const rows = await BannedPhrase.find().select('phrase').lean().exec()
    return rows.map((r) => r.phrase)
  },

  create(phrase: string, addedBy: Types.ObjectId) {
    return BannedPhrase.create({ phrase, addedBy })
  },

  deleteById(id: string) {
    return BannedPhrase.findByIdAndDelete(id).exec()
  },
}
