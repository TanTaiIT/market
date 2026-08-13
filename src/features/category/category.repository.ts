import { FilterQuery } from 'mongoose'
import { Category, ICategory, ICategoryDocument } from './category.model'

/**
 * Category nằm ngoài mô hình tenant (convention §1.3) nên repository này KHÔNG nhận
 * `organizationId` — khác hẳn `userRepository`, nơi tham số đó là bắt buộc. Đừng thêm
 * filter org vào đây: từ điển dùng chung mà lọc theo org là sai ngay từ ý niệm.
 */
export const categoryRepository = {
  list(opts: { includeInactive?: boolean } = {}) {
    const filter: FilterQuery<ICategoryDocument> = {}
    if (!opts.includeInactive) filter.isActive = true
    return Category.find(filter).sort({ order: 1, name: 1 })
  },

  findById(id: string) {
    return Category.findById(id)
  },

  /** Dùng lúc tạo tin: tin chỉ được gắn vào danh mục đang bật. */
  existsActive(id: string) {
    return Category.exists({ _id: id, isActive: true })
  },

  existsBySlug(slug: string) {
    return Category.exists({ slug })
  },

  create(data: Partial<ICategory>) {
    return Category.create(data)
  },

  updateById(id: string, update: Partial<ICategory>) {
    return Category.findByIdAndUpdate(id, update, { new: true, runValidators: true })
  },
}

/*
 * Cố tình KHÔNG có `delete`/`softDelete`. Gỡ một danh mục khỏi lưu thông = `isActive: false`
 * qua `updateById`, vì hai lý do:
 *
 * 1. Tin đã đăng vẫn trỏ vào `Listing.category`. Xoá là để lại tham chiếu mồ côi.
 * 2. Muốn xoá an toàn thì phải đếm tin của MỌI org đang dùng danh mục đó — mà `Listing` có
 *    tenantPlugin còn nhánh platform-admin không có scope, nên sẽ phải mở một call site
 *    `runUnscoped` mới ngay trong luồng request. Convention §6.4 xếp việc đó vào diện phải
 *    hỏi trước, và ở đây nó không đổi lại được gì: tắt đã đủ.
 *
 * Chốt chặn "còn tin trong danh mục này" của UI bàn quản trị thuộc về `OrganizationCategory`
 * (bước 5 trong `docs/architecture/admin-console.md`) — ở đó phép đếm nằm gọn trong một org.
 */
