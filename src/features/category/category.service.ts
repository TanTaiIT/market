import { categoryRepository } from './category.repository'
import { categoryTemplateService } from '../category-template/category-template.service'
import { ICategoryDocument } from './category.model'
import { CategoryQuery, CreateCategoryInput, UpdateCategoryInput } from './category.schema'
import { toCategoryDto } from './category.types'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { slugify } from '../../common/utils/slugify'
import { logger } from '../../config/logger'

export const categoryService = {
  async list(query: CategoryQuery) {
    const categories = await categoryRepository.list({ includeInactive: query.includeInactive })
    return categories.map(toCategoryDto)
  },

  async getById(id: string) {
    const category = await categoryRepository.findById(id)
    if (!category) throw new NotFoundError('Category not found')
    return toCategoryDto(category)
  },

  /**
   * Tin chỉ được gắn vào danh mục đang bật. Gọi từ `listingService` — chỗ duy nhất chặn được
   * `categoryId` đúng định dạng 24 hex nhưng không trỏ tới danh mục nào.
   *
   * TRẢ VỀ document chứ không phải void: người gọi còn cần `requireManualReview` của chính
   * danh mục vừa kiểm. Trả về ở đây là một lượt đọc; hỏi lại qua một method thứ hai là hai
   * lượt đọc cho cùng một bản ghi, trên đường nóng của mọi lượt đăng tin.
   */
  async assertUsable(categoryId: string): Promise<ICategoryDocument> {
    const category = await categoryRepository.findById(categoryId)
    if (!category?.isActive) {
      throw new BadRequestError('Danh mục không tồn tại hoặc đã ngừng sử dụng')
    }
    return category
  },

  async create(input: CreateCategoryInput, actorId: string) {
    const slug = input.slug ?? slugify(input.name)
    if (!slug)
      throw new BadRequestError('Không sinh được slug từ tên này, truyền `slug` tường minh')

    // Slug là khoá tra cứu ổn định của từ điển chung, nên trùng là chặn ở service chứ không
    // để rơi xuống lỗi duplicate key 11000 của Mongo — thông điệp ở đó không đọc được.
    if (await categoryRepository.existsBySlug(slug)) {
      throw new ConflictError(`Danh mục với slug "${slug}" đã tồn tại`)
    }

    const category = await categoryRepository.create({
      name: input.name,
      slug,
      icon: input.icon,
      order: input.order,
      requireManualReview: input.requireManualReview,
    })

    /*
     * Template đi kèm: tạo bản nháp rồi phát hành ngay trong cùng lượt gọi.
     *
     * Danh mục đã ghi trước đó và KHÔNG rollback nếu template hỏng — cố ý. Template sai chỉ là
     * một form thiếu field, sửa bằng `POST /categories/:id/template`; còn xoá ngược danh mục
     * vừa tạo thì phải xoá cả slug đã chiếm, mà slug là khoá tra cứu ổn định của từ điển chung.
     * Lỗi validate của template vẫn ném lên như thường, master thấy ngay và dựng lại bản nháp.
     */
    if (input.template) {
      const categoryId = category._id.toString()
      const draft = await categoryTemplateService.createDraft(categoryId, input.template)
      await categoryTemplateService.publish(categoryId, draft.version)
    }

    logger.info('platform-admin category-create', {
      adminId: actorId,
      slug,
      name: input.name,
      withTemplate: Boolean(input.template),
    })
    return toCategoryDto(category)
  },

  /**
   * Không cho đổi `slug`: nó là khoá tra cứu mà client (app mobile, bàn quản trị) có thể đã
   * cache. Đổi tên hiển thị dùng `name`.
   */
  async update(id: string, input: UpdateCategoryInput, actorId: string) {
    const category = await categoryRepository.updateById(id, input)
    if (!category) throw new NotFoundError('Category not found')

    logger.info('platform-admin category-update', {
      adminId: actorId,
      categoryId: id,
      changed: Object.keys(input),
    })
    return toCategoryDto(category)
  },
}
