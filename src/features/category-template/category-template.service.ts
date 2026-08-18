import { categoryTemplateRepository } from './category-template.repository'
import { ICategoryTemplateDocument } from './category-template.model'
import { toTemplateDto, ResolvedTemplate } from './category-template.types'
import { validateAttributes, ValidatedAttributes } from './category-template.validate'

/**
 * Chưa seed template nào — danh mục KHÔNG có thuộc tính động.
 *
 * Đây là một trạng thái hợp lệ, không phải lỗi: trước tính năng này mọi danh mục đều như vậy.
 * Ném 404 ở đây sẽ biến "quên chạy seed" thành "không đăng được tin nào" — đổi một sai sót
 * cấu hình thành sự cố toàn hệ thống.
 *
 * `templateId: null` để `Listing.templateRef` không trỏ vào một bản ghi không tồn tại.
 */
const NO_TEMPLATE: ResolvedTemplate = {
  templateId: null,
  version: 0,
  isFallback: true,
  fields: [],
}

/**
 * Đi từ template (dữ liệu) sang field đã ghép (thứ FE và validate dùng).
 *
 * Tách riêng vì cả ba đường vào — lấy theo danh mục, lấy fallback, lấy đúng version của một
 * tin cũ — đều kết thúc ở cùng một phép ghép với từ điển.
 */
async function resolve(
  template: ICategoryTemplateDocument | null,
): Promise<ResolvedTemplate | null> {
  if (!template) return null
  const defs = await categoryTemplateRepository.findDefinitionsByKeys(
    template.fieldKeys.map((f) => f.key),
  )
  return toTemplateDto(template, defs)
}

export const categoryTemplateService = {
  /**
   * Template đang phục vụ cho một danh mục. Chưa có bản riêng thì rơi về bản chung — đó là lý
   * do fallback tồn tại (đặc tả §4.7): mọi danh mục đều đăng tin được, kể cả danh mục vừa tạo.
   */
  async getForCategory(categoryId: string, version?: number): Promise<ResolvedTemplate> {
    /*
     * `version` = "dựng lại đúng bộ field mà tin này được tạo ra với nó" (form sửa tin).
     *
     * Thử đúng hai nguồn theo cùng thứ tự với đường không ghim: template riêng của danh mục,
     * rồi bản chung. Không tìm thấy thì RƠI XUỐNG bản mới nhất thay vì lỗi — version đó có
     * thể đã bị xoá, mà sửa tin bằng một form hơi lệch vẫn tốt hơn là không sửa được.
     */
    if (version != null) {
      const pinned =
        (await resolve(
          await categoryTemplateRepository.findByCategoryAndVersion(categoryId, version),
        )) ?? (await resolve(await categoryTemplateRepository.findFallbackByVersion(version)))
      if (pinned) return pinned
    }

    const specific = await resolve(
      await categoryTemplateRepository.findPublishedByCategory(categoryId),
    )
    if (specific) return specific

    const fallback = await resolve(await categoryTemplateRepository.findPublishedFallback())
    return fallback ?? NO_TEMPLATE
  },

  /**
   * Validate `attributes` của một tin theo template của danh mục nó.
   *
   * Chỗ ghi DUY NHẤT được phép của `Listing.attributes`: nó vừa ép kiểu vừa loại key lạ, nên
   * bỏ qua nó ở một đường ghi nào đó là để kiểu tuỳ tiện lọt thẳng vào `Map of Mixed`.
   */
  async validateForCategory(
    categoryId: string,
    raw: Record<string, unknown> | undefined,
    /**
     * Ghim theo version của tin đang sửa. Bỏ trống = bản mới nhất (tin mới, hoặc tin vừa đổi
     * danh mục). Thiếu tham số này thì sửa một tin cũ sẽ bị đòi field chỉ có ở template v2 —
     * field mà form của họ chưa từng hiện ra.
     */
    version?: number,
  ): Promise<
    ValidatedAttributes & { templateId: string | null; version: number; isFallback: boolean }
  > {
    const template = await this.getForCategory(categoryId, version)
    const { attributes, attrs } = validateAttributes(template, raw ?? {})

    return {
      attributes,
      attrs,
      templateId: template.templateId,
      version: template.version,
      isFallback: template.isFallback,
    }
  },
}
