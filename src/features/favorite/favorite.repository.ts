import { Types } from 'mongoose'
import { Favorite } from './favorite.model'
import { PaginationParams } from '../../common/utils/pagination'

/** Mã lỗi unique index của MongoDB. */
const DUPLICATE_KEY = 11000

export const favoriteRepository = {
  /**
   * `true` = vừa tạo mới, `false` = đã lưu từ trước.
   *
   * Bắt lỗi duplicate key thay vì `findOne` rồi `create`: hai lượt bấm sát nhau (hoặc hai
   * thiết bị) đi qua khe giữa hai câu lệnh sẽ tạo hai bản ghi, và bộ đếm `favoriteCount`
   * cộng hai lần cho cùng một người. Ở đây index là trọng tài, không phải thời điểm.
   */
  async add(userId: Types.ObjectId, listingId: Types.ObjectId): Promise<boolean> {
    try {
      await Favorite.create({ userId, listingId })
      return true
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return false
      throw err
    }
  },

  /** `true` = vừa xoá, `false` = vốn đã không lưu. Cũng là điều kiện để trừ `favoriteCount`. */
  async remove(userId: Types.ObjectId, listingId: Types.ObjectId): Promise<boolean> {
    const res = await Favorite.deleteOne({ userId, listingId })
    return res.deletedCount === 1
  },

  /** Toàn bộ id đã lưu — client dùng để tô tim trên danh sách, nên không phân trang. */
  async listingIdsOf(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const rows = await Favorite.find({ userId })
      .sort({ createdAt: -1 })
      .select('listingId')
      .lean()
      .exec()
    return rows.map((row) => row.listingId)
  },

  async paginate(userId: Types.ObjectId, { skip, limit }: PaginationParams) {
    const [rows, total] = await Promise.all([
      Favorite.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('listingId')
        .lean()
        .exec(),
      Favorite.countDocuments({ userId }),
    ])
    return { listingIds: rows.map((row) => row.listingId), total }
  },
}
