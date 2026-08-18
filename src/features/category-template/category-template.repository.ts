import { TEMPLATE_STATUS } from '../../common/constants'
import { CategoryTemplate, FieldDefinition } from './category-template.model'

/**
 * Hai collection nằm ngoài mô hình tenant (convention §1.3) nên repository này KHÔNG nhận
 * `organizationId` — giống hệt `categoryRepository`. Đừng thêm filter org: từ điển dùng chung
 * mà lọc theo org là sai ngay từ ý niệm.
 */
export const categoryTemplateRepository = {
  /**
   * Bản `published` MỚI NHẤT của một danh mục.
   *
   * `sort({ version: -1 }).limit(1)` là hợp đồng của cả feature (đặc tả §Bước 6): bản cũ ở lại
   * `published` vĩnh viễn để tin đã đăng còn đọc được, nên "bản đang dùng" chỉ được định nghĩa
   * bằng version cao nhất, không bao giờ bằng trạng thái.
   */
  findPublishedByCategory(categoryId: string) {
    return CategoryTemplate.findOne({ categoryId, status: TEMPLATE_STATUS.PUBLISHED })
      .sort({ version: -1 })
      .exec()
  },

  /** Bản chung, dùng khi danh mục chưa có template riêng. */
  findPublishedFallback() {
    return CategoryTemplate.findOne({ isFallback: true, status: TEMPLATE_STATUS.PUBLISHED })
      .sort({ version: -1 })
      .exec()
  },

  /**
   * Bản ĐÚNG version mà một tin đã đăng trỏ tới — không phải bản mới nhất.
   *
   * Form sửa tin phải dựng lại đúng bộ field lúc tin được tạo: đọc bản mới nhất thì tin cũ
   * hiện field chưa từng có, và field đã bỏ thì mất giá trị người dùng đã nhập.
   *
   * Không lọc `status`: bản cũ ở lại `published` vĩnh viễn, nhưng kể cả khi một ngày nào đó
   * nó bị rút thì tin đang trỏ vào nó vẫn phải sửa được.
   */
  findByCategoryAndVersion(categoryId: string, version: number) {
    return CategoryTemplate.findOne({ categoryId, version }).exec()
  },

  /** Bản chung ở đúng một version — tin đăng khi danh mục chưa có template riêng. */
  findFallbackByVersion(version: number) {
    return CategoryTemplate.findOne({ isFallback: true, version }).exec()
  },

  /** Từ điển field cho một danh sách key — nguồn `label`/`options`/`min`/`max` của `toTemplateDto`. */
  findDefinitionsByKeys(keys: string[]) {
    return FieldDefinition.find({ key: { $in: keys } }).exec()
  },
}
