import { FIELD_TYPE, NUMERIC_FIELD_TYPES } from '../../common/constants'
import { BadRequestError } from '../../common/errors'
import type { ResolvedField, ResolvedTemplate } from './category-template.types'

/*
 * Validate `attributes` của một tin theo template của danh mục — hàm THUẦN, không chạm DB.
 *
 * Tách khỏi service vì đây là chỗ duy nhất có luật nghiệp vụ thật của cả feature, và luật đó
 * phải test được mà không dựng Mongo lẫn HTTP (`tests/unit/`). Service chỉ lo đi lấy template.
 *
 * KHÔNG nằm ở zod (`validate()` middleware): middleware là tĩnh, còn template thì tra theo
 * `categoryId` nằm trong chính body — xem `listing-template.plan.md` §0.2.
 */

/** Giá trị một field có thể mang sau khi đã ép kiểu. `attributes` là `Map of Mixed` bên Mongo. */
type AttributeValue = string | number | boolean | string[]

const MAX_TEXT_LENGTH = 500

/**
 * Field này có hiện không, xét trên các giá trị người dùng đã nhập.
 *
 * Field bị ẩn thì `required` của nó KHÔNG được áp — thiếu bước này thì tin xe đạp bị đòi
 * `engineCc`. FE cài đúng luật này ở `AttrFields.tsx`; hai bên lệch nhau là form hợp lệ mà
 * server trả 400.
 */
export function isFieldVisible(field: ResolvedField, raw: Record<string, unknown>): boolean {
  const cond = field.showIf
  if (!cond) return true

  const actual = raw[cond.key]
  if (cond.in) return cond.in.includes(String(actual))
  if (cond.eq !== undefined) {
    // So bằng chuỗi: form HTML trả `"true"` cho boolean và `"2020"` cho số, mà điều kiện thì
    // khai bằng giá trị thật. Ép cả hai về chuỗi là phép so duy nhất đúng cho cả ba kiểu.
    return String(actual) === String(cond.eq)
  }
  return true
}

/** Danh sách field đang hiện, đã sắp theo `order` — dùng chung cho validate và cho response. */
function visibleFields(template: ResolvedTemplate, raw: Record<string, unknown>): ResolvedField[] {
  return template.fields.filter((f) => isFieldVisible(f, raw)).sort((a, b) => a.order - b.order)
}

function coerceNumber(field: ResolvedField, value: unknown): number {
  const num = Number(value)
  if (Number.isNaN(num)) throw new BadRequestError(`${field.label} phải là số`)
  if (field.min != null && num < field.min) {
    throw new BadRequestError(`${field.label} tối thiểu ${field.min}`)
  }
  if (field.max != null && num > field.max) {
    throw new BadRequestError(`${field.label} tối đa ${field.max}`)
  }
  return num
}

function coerceSelect(field: ResolvedField, value: unknown): string {
  const picked = String(value)
  if (!field.options.some((o) => o.value === picked)) {
    throw new BadRequestError(`${field.label} không hợp lệ`)
  }
  return picked
}

function coerceMultiSelect(field: ResolvedField, value: unknown): string[] {
  const list = (Array.isArray(value) ? value : [value]).map(String)
  const allowed = new Set(field.options.map((o) => o.value))
  if (list.some((v) => !allowed.has(v))) {
    throw new BadRequestError(`${field.label} không hợp lệ`)
  }
  // Bỏ trùng: client gửi hai lần cùng một option thì `attrs` sinh ra hai phần tử giống hệt
  // và bộ lọc đếm sai.
  return [...new Set(list)]
}

function coerce(field: ResolvedField, value: unknown): AttributeValue {
  if (NUMERIC_FIELD_TYPES.includes(field.type)) return coerceNumber(field, value)

  switch (field.type) {
    case FIELD_TYPE.BOOLEAN:
      return value === true || value === 'true'
    case FIELD_TYPE.SELECT:
      return coerceSelect(field, value)
    case FIELD_TYPE.MULTISELECT:
      return coerceMultiSelect(field, value)
    default:
      return String(value).trim().slice(0, MAX_TEXT_LENGTH)
  }
}

/** Rỗng theo nghĩa "người dùng không nhập gì" — `false` và `0` là giá trị THẬT, không rỗng. */
function isBlank(value: unknown): boolean {
  if (value == null || value === '') return true
  return Array.isArray(value) && value.length === 0
}

export interface ValidatedAttributes {
  /** Đã ép kiểu, chỉ gồm key có trong template và đang hiện. */
  attributes: Record<string, AttributeValue>
  /** Bản phẳng để lọc — CHỈ field `filterable`, xem plan §0.3. */
  attrs: { k: string; v: AttributeValue }[]
}

/**
 * Bắt buộc chạy ở MỌI đường ghi `attributes`. Ba việc nó làm, theo đặc tả §5.4:
 *
 * 1. **Ép kiểu** — `storage: "256"` không match `$gte: 128`, form thì luôn trả chuỗi.
 * 2. **Kiểm option** — không tin `select` từ client; người dùng gọi thẳng API được.
 * 3. **Loại key lạ** — chỉ giữ key có trong template, nên client bịa field không làm bẩn DB.
 */
export function validateAttributes(
  template: ResolvedTemplate,
  raw: Record<string, unknown>,
): ValidatedAttributes {
  const attributes: Record<string, AttributeValue> = {}
  const attrs: ValidatedAttributes['attrs'] = []

  for (const field of visibleFields(template, raw)) {
    const value = raw[field.key]

    if (isBlank(value)) {
      if (field.required) throw new BadRequestError(`Thiếu trường: ${field.label}`)
      continue
    }

    const clean = coerce(field, value)
    attributes[field.key] = clean

    if (!field.filterable) continue
    // `multiselect` tách thành nhiều phần tử: lọc "có điều hoà" là tìm MỘT giá trị trong mảng,
    // mà `$elemMatch` trên một phần tử chứa cả mảng thì không so được từng phần.
    if (Array.isArray(clean)) attrs.push(...clean.map((v) => ({ k: field.key, v })))
    else attrs.push({ k: field.key, v: clean })
  }

  return { attributes, attrs }
}
