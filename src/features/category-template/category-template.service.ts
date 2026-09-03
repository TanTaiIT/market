import { Types } from 'mongoose'
import { categoryTemplateRepository } from './category-template.repository'
import { IFieldDefinitionDocument } from './category-template.model'
import {
  CreateFieldDefinitionInput,
  TemplateFieldInput,
  TemplateFieldsInput,
} from './category-template.schema'
import { toFieldDefinitionDto } from './category-template.types'
import { categoryRepository } from '../category/category.repository'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { TEMPLATE_STATUS } from '../../common/constants'
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

// ── ĐƯỜNG GHI (master) ──────────────────────────────────────────────────────

/**
 * Trần số field mở lọc trong một template.
 *
 * Mỗi field `filterable` là một phần tử thêm vào `Listing.attrs` của MỌI tin thuộc danh mục
 * đó, và một nhánh nữa mà index `attrs.k/attrs.v` phải quét. Đây từng là một dòng ghi chú
 * trong seed rồi bị bỏ qua — 11 field phải hạ xuống bằng tay sau đó. Thành luật thì nó không
 * trôi lại được.
 */
const MAX_FILTERABLE_FIELDS = 8

/**
 * Ghép `fields` với từ điển, tạo định nghĩa mới nếu master khai `define`.
 *
 * Trả về map `key -> IFieldDefinition` để bước kiểm sau tính được `filterable` hiệu lực.
 */
async function resolveDefinitions(fields: TemplateFieldInput[]) {
  const keys = fields.map((field) => field.key)
  const existing = await categoryTemplateRepository.findDefinitionsByKeys(keys)
  const byKey = new Map(existing.map((def) => [def.key, def]))

  for (const field of fields) {
    const known = byKey.get(field.key)

    if (known && field.define && field.define.type !== known.type) {
      throw new BadRequestError(
        `Field "${field.key}" đã tồn tại trong từ điển với kiểu "${known.type}" — ` +
          'một khoá không được mang hai kiểu, đổi key hoặc bỏ phần định nghĩa',
      )
    }
    if (known) continue

    if (!field.define) {
      throw new BadRequestError(
        `Field "${field.key}" chưa có trong từ điển — khai "define" để tạo mới`,
      )
    }

    byKey.set(
      field.key,
      await categoryTemplateRepository.createDefinition({ key: field.key, ...field.define }),
    )
  }

  return byKey
}

/** Bốn chốt hình dạng, chạy trước mọi lượt ghi. */
function assertTemplateShape(
  fields: TemplateFieldInput[],
  definitions: Map<string, IFieldDefinitionDocument>,
) {
  const keys = new Set<string>()
  const orders = new Set<number>()
  for (const field of fields) {
    if (keys.has(field.key)) throw new BadRequestError(`Field "${field.key}" khai hai lần`)
    if (orders.has(field.order)) {
      throw new BadRequestError(
        `Hai field cùng order ${field.order} — thứ tự hiện form sẽ tuỳ hứng`,
      )
    }
    keys.add(field.key)
    orders.add(field.order)
  }

  for (const field of fields) {
    // `showIf` trỏ ra ngoài template là một field không bao giờ hiện: điều kiện của nó đọc một
    // khoá mà form này không có, nên luôn sai.
    if (field.showIf && !keys.has(field.showIf.key)) {
      throw new BadRequestError(
        `Field "${field.key}" phụ thuộc "${field.showIf.key}" nhưng khoá đó không có trong template`,
      )
    }
  }

  const filterable = fields.filter(
    (field) => field.filterable ?? definitions.get(field.key)?.filterable ?? false,
  ).length
  if (filterable > MAX_FILTERABLE_FIELDS) {
    throw new BadRequestError(
      `${filterable} field mở lọc, tối đa ${MAX_FILTERABLE_FIELDS} — mỗi field lọc là một nhánh ` +
        'index phải quét trên mọi tin của danh mục này',
    )
  }
}

const toTemplateFields = (fields: TemplateFieldInput[]) =>
  fields.map((field) => ({
    key: field.key,
    order: field.order,
    required: field.required,
    filterable: field.filterable,
    group: field.group,
    showIf: field.showIf,
    override: field.override,
  }))

/**
 * Ghi `fields` vào một bản NHÁP đã tìm được.
 *
 * Tách ra vì template của danh mục và MẪU MẶC ĐỊNH chỉ khác nhau ở cách TÌM ra bản đó — còn
 * luật ghi thì đúng một bộ. Chép đôi ở đây nghĩa là lần siết luật sau chỉ siết một nửa.
 */
async function writeDraft(doc: ICategoryTemplateDocument | null, input: TemplateFieldsInput) {
  if (!doc) throw new NotFoundError('Template not found')
  if (doc.status !== TEMPLATE_STATUS.DRAFT) {
    throw new BadRequestError(
      'Bản đã phát hành không sửa được — tạo bản nháp mới, tin cũ vẫn đọc bản này',
    )
  }

  const definitions = await resolveDefinitions(input.fields)
  assertTemplateShape(input.fields, definitions)

  doc.fieldKeys = toTemplateFields(input.fields)
  await doc.save()
}

/** Đóng dấu phát hành cho một bản nháp đã tìm được. Cùng lý do tách như `writeDraft`. */
async function markPublished(doc: ICategoryTemplateDocument | null) {
  if (!doc) throw new NotFoundError('Template not found')
  if (doc.status === TEMPLATE_STATUS.PUBLISHED) {
    throw new BadRequestError('Bản này đã phát hành rồi')
  }

  // Kiểm lại lúc phát hành, không chỉ lúc ghi: từ điển có thể đã xoá mềm một field kể từ khi
  // bản nháp được tạo, và lúc đó form sẽ hiện một ô không có định nghĩa nào phía sau.
  const fields = doc.fieldKeys as TemplateFieldInput[]
  const definitions = await resolveDefinitions(fields)
  assertTemplateShape(fields, definitions)

  doc.status = TEMPLATE_STATUS.PUBLISHED
  doc.publishedAt = new Date()
  await doc.save()
}

export const categoryTemplateService = {
  /**
   * Template đang phục vụ cho một danh mục. Chưa có bản riêng thì rơi về bản chung — đó là lý
   * do fallback tồn tại (đặc tả §4.7): mọi danh mục đều đăng tin được, kể cả danh mục vừa tạo.
   */
  /** Từ điển field dùng chung — màn dựng template đọc nó để master chọn. */
  async listFieldDefinitions() {
    const rows = await categoryTemplateRepository.listDefinitions()
    return rows.map(toFieldDefinitionDto)
  },

  async createFieldDefinition(input: CreateFieldDefinitionInput) {
    const [existing] = await categoryTemplateRepository.findDefinitionsByKeys([input.key])
    if (existing) throw new ConflictError(`Field "${input.key}" đã có trong từ điển`)
    return toFieldDefinitionDto(await categoryTemplateRepository.createDefinition(input))
  },

  /**
   * Tạo bản nháp version kế tiếp cho một danh mục.
   *
   * Không sửa bản đã publish, kể cả khi nó vừa được tạo một phút trước: tin đăng ghim
   * `templateRef.version`, và form sửa tin dựng lại đúng bộ field lúc tin ra đời. Mutate bản
   * cũ nghĩa là tin cũ đột nhiên mang field chưa từng tồn tại với chúng.
   */
  async createDraft(categoryId: string, input: TemplateFieldsInput) {
    const category = await categoryRepository.findById(categoryId)
    if (!category) throw new NotFoundError('Category not found')

    const definitions = await resolveDefinitions(input.fields)
    assertTemplateShape(input.fields, definitions)

    const latest = await categoryTemplateRepository.findLatestByCategory(categoryId)
    const doc = await categoryTemplateRepository.createTemplate({
      categoryId: new Types.ObjectId(categoryId),
      isFallback: false,
      version: (latest?.version ?? 0) + 1,
      status: TEMPLATE_STATUS.DRAFT,
      fieldKeys: toTemplateFields(input.fields),
    })
    return this.getForCategory(categoryId, doc.version)
  },

  async updateDraft(categoryId: string, version: number, input: TemplateFieldsInput) {
    await writeDraft(
      await categoryTemplateRepository.findByCategoryAndVersion(categoryId, version),
      input,
    )
    return this.getForCategory(categoryId, version)
  },

  async publish(categoryId: string, version: number) {
    await markPublished(
      await categoryTemplateRepository.findByCategoryAndVersion(categoryId, version),
    )
    return this.getForCategory(categoryId, version)
  },

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

  /*
   * ── MẪU MẶC ĐỊNH (`isFallback`) ─────────────────────────────────────────
   *
   * Bản dùng cho mọi danh mục chưa có template riêng. Nó KHÔNG thuộc danh mục nào
   * (`categoryId: null`) nên không đi qua `/categories/:id/template` được — bốn đường dưới đây
   * là bản song song, dùng chung toàn bộ luật ghi với đường của danh mục.
   *
   * Trước đây chỉ `scripts/seed-templates.ts` đặt được bản này, tức là đổi mẫu mặc định phải
   * vào server chạy script.
   */
  async getFallback(version?: number): Promise<ResolvedTemplate> {
    if (version != null) {
      const pinned = await resolve(await categoryTemplateRepository.findFallbackByVersion(version))
      if (pinned) return pinned
    }
    const published = await resolve(await categoryTemplateRepository.findPublishedFallback())
    return published ?? NO_TEMPLATE
  },

  async createFallbackDraft(input: TemplateFieldsInput) {
    const definitions = await resolveDefinitions(input.fields)
    assertTemplateShape(input.fields, definitions)

    const latest = await categoryTemplateRepository.findLatestFallback()
    const doc = await categoryTemplateRepository.createTemplate({
      // `null` KHI VÀ CHỈ KHI `isFallback` — hợp đồng đã ghi ở `ICategoryTemplate`.
      categoryId: null,
      isFallback: true,
      version: (latest?.version ?? 0) + 1,
      status: TEMPLATE_STATUS.DRAFT,
      fieldKeys: toTemplateFields(input.fields),
    })
    return this.getFallback(doc.version)
  },

  async updateFallbackDraft(version: number, input: TemplateFieldsInput) {
    await writeDraft(await categoryTemplateRepository.findFallbackByVersion(version), input)
    return this.getFallback(version)
  },

  async publishFallback(version: number) {
    await markPublished(await categoryTemplateRepository.findFallbackByVersion(version))
    return this.getFallback(version)
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
