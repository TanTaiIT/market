import { Types } from 'mongoose'
import { favoriteRepository } from './favorite.repository'
import { FavoriteQuery } from './favorite.schema'
import { listingService } from '../listing/listing.service'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'

export const favoriteService = {
  /**
   * Lưu tin. Đọc tin TRƯỚC khi ghi để `tenantPlugin` có chỗ lên tiếng: tin của org khác trả
   * 404 ngay ở đây, thay vì để người dùng lưu được một id mà mãi mãi không mở nổi nội dung.
   *
   * Bộ đếm chỉ động khi bản ghi THẬT SỰ mới — bấm tim hai lần không cộng hai.
   */
  async add(userId: string, listingId: string) {
    const listing = await listingService.getById(listingId)
    const created = await favoriteRepository.add(new Types.ObjectId(userId), listing._id)
    if (created) await listingService.adjustFavoriteCount(listing._id, 1)
    return { listingId, favorited: true }
  },

  /**
   * Bỏ lưu. KHÔNG kiểm tin còn tồn tại: tin bị gỡ hoặc bị ẩn vẫn phải bỏ tim được, nếu không
   * người dùng kẹt vĩnh viễn với một bản ghi họ không xoá nổi.
   */
  async remove(userId: string, listingId: string) {
    const id = new Types.ObjectId(listingId)
    const removed = await favoriteRepository.remove(new Types.ObjectId(userId), id)
    if (removed) await listingService.adjustFavoriteCount(id, -1)
    return { listingId, favorited: false }
  },

  /** Chỉ id, không phân trang: client cần đủ tập này để tô tim trên MỌI danh sách đang mở. */
  async listIds(userId: string) {
    const ids = await favoriteRepository.listingIdsOf(new Types.ObjectId(userId))
    return ids.map((id) => id.toString())
  },

  /**
   * Danh sách tin đã lưu, đã phân trang.
   *
   * `meta.total` đếm BẢN GHI ĐÃ LƯU, còn `data` chỉ chứa tin đọc được — một trang có thể ngắn
   * hơn `limit` khi trong đó có tin đã gỡ. Không tự dọn bản ghi mồ côi ở đường đọc: tin bị ẩn
   * tạm thời rồi hiện lại là chuyện thường, xoá đi là mất tim của người dùng vì một trạng
   * thái nhất thời.
   */
  async list(userId: string, query: FavoriteQuery) {
    const pagination = parsePagination(query)
    const { listingIds, total } = await favoriteRepository.paginate(
      new Types.ObjectId(userId),
      pagination,
    )
    const items = await listingService.getManyByIds(listingIds)
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },
}
