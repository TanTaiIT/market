import { Category } from '../src/features/category/category.model'
import {
  CategoryTemplate,
  FieldDefinition,
  IFieldDefinition,
  ITemplateField,
} from '../src/features/category-template/category-template.model'
import { FIELD_TYPE, TEMPLATE_STATUS } from '../src/common/constants'

/*
 * Từ điển danh mục + field + template — SoT của dữ liệu, dùng chung bởi `seed.ts` (dựng cả
 * môi trường dev) và `seed-templates.ts` (chỉ cập nhật từ điển, chạy được cả trên môi trường
 * đang có dữ liệu thật).
 *
 * Mọi thao tác là `upsert` theo khoá tự nhiên (`key` / `slug` / `slug+version`) nên chạy bao
 * nhiêu lần cũng ra cùng một trạng thái — đó là điều kiện để `seed.ts` gọi lại nó sau khi đã
 * `deleteMany` phần dữ liệu nghiệp vụ mà không làm mồ côi `template.categoryId`.
 */

/** `value` vào DB, `label` để hiển thị. Chuỗi trần thì dùng luôn nó cho cả hai. */
const opts = (...values: (string | [string, string])[]) =>
  values.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v }))

type FieldSeed = Omit<IFieldDefinition, 'deletedAt' | 'createdAt' | 'updatedAt' | 'options'> & {
  options?: IFieldDefinition['options']
}

// ── TỪ ĐIỂN FIELD ───────────────────────────────────────────────────────────
// Dùng lại giữa các danh mục là mục đích chính của bảng này: `brand` chỉ được định nghĩa MỘT
// lần ở đây, danh mục nào cần dropdown riêng thì `override` trong template của nó.

export const FIELD_DEFS: FieldSeed[] = [
  /* --- dùng ở gần như mọi danh mục --- */
  { key: 'brand', label: 'Hãng', type: FIELD_TYPE.TEXT, filterable: true },
  {
    key: 'condition',
    label: 'Tình trạng',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['new', 'Mới, chưa dùng'],
      ['like_new', 'Như mới (99%)'],
      ['good', 'Tốt, dùng bình thường'],
      ['fair', 'Cũ, còn dùng được'],
      ['broken', 'Hỏng, bán xác'],
    ),
  },
  { key: 'warranty', label: 'Còn bảo hành', type: FIELD_TYPE.BOOLEAN, filterable: true },
  { key: 'warrantyUntil', label: 'Bảo hành đến', type: FIELD_TYPE.TEXT, filterable: false },
  { key: 'quantity', label: 'Số lượng', type: FIELD_TYPE.NUMBER, min: 1, filterable: false },
  { key: 'color', label: 'Màu sắc', type: FIELD_TYPE.TEXT, filterable: false },
  { key: 'yearBought', label: 'Năm mua', type: FIELD_TYPE.YEAR, min: 1990, filterable: false },
  {
    key: 'origin',
    label: 'Xuất xứ',
    type: FIELD_TYPE.SELECT,
    filterable: false,
    options: opts(['vn', 'Việt Nam'], ['imported', 'Nhập khẩu'], ['unknown', 'Không rõ']),
  },

  /* --- nhóm điện tử (điện thoại + đồ điện tử) --- */
  {
    key: 'storage',
    label: 'Bộ nhớ trong',
    type: FIELD_TYPE.SELECT,
    unit: 'GB',
    filterable: true,
    options: opts('16', '32', '64', '128', '256', '512', '1024'),
  },
  {
    key: 'ram',
    label: 'RAM',
    type: FIELD_TYPE.SELECT,
    unit: 'GB',
    filterable: true,
    options: opts('2', '3', '4', '6', '8', '12', '16', '32', '64'),
  },
  {
    key: 'accessories',
    label: 'Phụ kiện kèm theo',
    type: FIELD_TYPE.MULTISELECT,
    filterable: false,
    options: opts(
      ['box', 'Hộp'],
      ['charger', 'Sạc'],
      ['cable', 'Cáp'],
      ['earphone', 'Tai nghe'],
      ['case', 'Ốp / bao da'],
      ['invoice', 'Hoá đơn'],
    ),
  },

  /* --- riêng Điện thoại --- */
  {
    key: 'model',
    label: 'Dòng máy',
    type: FIELD_TYPE.TEXT,
    filterable: false,
    placeholder: 'VD: iPhone 13 Pro Max',
  },
  {
    key: 'batteryHealth',
    label: 'Độ chai pin',
    type: FIELD_TYPE.NUMBER,
    unit: '%',
    min: 0,
    max: 100,
    filterable: true,
    helpText: 'Xem ở Cài đặt → Pin → Tình trạng pin',
  },
  {
    key: 'repairHistory',
    label: 'Lịch sử sửa chữa',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['original', 'Nguyên bản, chưa sửa'],
      ['screen', 'Đã thay màn hình'],
      ['battery', 'Đã thay pin'],
      ['multiple', 'Đã sửa nhiều hạng mục'],
    ),
  },
]

// ── DANH MỤC ────────────────────────────────────────────────────────────────

interface CategorySeed {
  name: string
  slug: string
  icon: string
  order: number
  isActive?: boolean
  requireManualReview?: boolean
}

export const CATEGORIES: CategorySeed[] = [
  { name: 'Điện thoại', slug: 'dien-thoai', icon: '📱', order: 10 },
  { name: 'Đồ điện tử', slug: 'do-dien-tu', icon: '💻', order: 20 },
  { name: 'Bất động sản', slug: 'bat-dong-san', icon: '🏠', order: 30 },
  { name: 'Xe cộ', slug: 'xe-co', icon: '🛵', order: 40 },
  { name: 'Đồ gia dụng', slug: 'do-gia-dung', icon: '🔌', order: 50 },
  /*
   * Thú cưng ra đời ở trạng thái TẮT, cố ý.
   *
   * Buôn bán động vật hoang dã là vi phạm hình sự ở Việt Nam, và chính sách của Google Play /
   * App Store với hạng mục động vật sống cần đọc lại từ nguồn chính thức trước khi mở. Bật
   * bằng một lượt `PATCH /platform-admin/categories/{id}` sau khi đã kiểm tra — rẻ hơn nhiều
   * so với gỡ danh mục khi đã có người dùng.
   */
  {
    name: 'Thú cưng',
    slug: 'thu-cung',
    icon: '🐕',
    order: 60,
    isActive: false,
    requireManualReview: true,
  },
  { name: 'Khác', slug: 'khac', icon: '📦', order: 70 },
]

// ── TEMPLATE ────────────────────────────────────────────────────────────────

interface TemplateSeed {
  /** `null` = bản chung, không thuộc danh mục nào. */
  slug: string | null
  version: number
  fieldKeys: ITemplateField[]
}

export const TEMPLATES: TemplateSeed[] = [
  /*
   * Bản chung. Chỉ 4 field, KHÔNG cái nào bắt buộc: nó phải phục vụ được cả sách vở lẫn nhạc
   * cụ lẫn vé sự kiện, nên mọi ràng buộc chặt hơn đều sai với một danh mục nào đó.
   */
  {
    slug: null,
    version: 1,
    fieldKeys: [
      {
        key: 'brand',
        order: 10,
        required: false,
        filterable: true,
        override: { placeholder: 'Bỏ trống nếu không có' },
      },
      { key: 'quantity', order: 20, required: false },
      { key: 'origin', order: 30, required: false },
      { key: 'warranty', order: 40, required: false, filterable: true },
    ],
  },

  {
    slug: 'dien-thoai',
    version: 1,
    fieldKeys: [
      {
        key: 'brand',
        order: 10,
        required: true,
        filterable: true,
        // Dropdown thay ô nhập tự do: `brand` là field lọc, mà gõ tay thì "Iphone"/"iphone"/
        // "IPhone" thành ba giá trị khác nhau và bộ lọc vỡ.
        override: {
          type: FIELD_TYPE.SELECT,
          options: opts(
            ['apple', 'Apple'],
            ['samsung', 'Samsung'],
            ['xiaomi', 'Xiaomi'],
            ['oppo', 'OPPO'],
            ['vivo', 'vivo'],
            ['realme', 'realme'],
            ['nokia', 'Nokia'],
            ['nubia', 'Nubia'],
            ['other', 'Khác'],
          ),
        },
      },
      { key: 'model', order: 20, required: true },
      { key: 'storage', order: 30, required: true, filterable: true },
      { key: 'color', order: 40, required: false },
      { key: 'batteryHealth', order: 50, required: false, filterable: true },
      // `required` có chủ ý: đây là thông tin người mua quan tâm nhất và là chỗ hay bị giấu.
      { key: 'repairHistory', order: 60, required: true, filterable: true },
      { key: 'accessories', order: 70, required: false },
      { key: 'warranty', order: 80, required: false, filterable: true },
      { key: 'warrantyUntil', order: 90, required: false, showIf: { key: 'warranty', eq: true } },
    ],
  },
]

// ── UPSERT ──────────────────────────────────────────────────────────────────

/**
 * Ghi từ điển vào DB theo đúng thứ tự phụ thuộc: field → danh mục → template (template trỏ
 * tới cả hai). Idempotent — khoá tự nhiên là `key` / `slug` / `(categoryId, version)`.
 *
 * Template ĐÃ PUBLISH bị ghi đè ở đây, khác với luật "không sửa bản đã publish" của runtime.
 * Đó là chủ ý: file này LÀ định nghĩa của version đó, nên sửa nội dung ở đây rồi chạy lại là
 * cách duy nhất để sửa một lỗi seed. Đổi hình dạng thật sự thì tăng `version`, đừng sửa bản cũ
 * — tin đã đăng vẫn trỏ vào nó.
 */
export async function upsertCatalog(): Promise<Map<string, string>> {
  for (const field of FIELD_DEFS) {
    await FieldDefinition.updateOne(
      { key: field.key },
      { $set: { ...field, options: field.options ?? [] } },
      { upsert: true },
    )
  }

  const idBySlug = new Map<string, string>()
  for (const category of CATEGORIES) {
    // `$setOnInsert` cho hai cờ vận hành: bật Thú cưng bằng tay xong mà seed chạy lại tắt nó
    // đi là mất công của người vừa duyệt policy.
    const { isActive, requireManualReview, ...always } = category
    await Category.updateOne(
      { slug: category.slug },
      {
        $set: always,
        $setOnInsert: {
          isActive: isActive ?? true,
          requireManualReview: requireManualReview ?? false,
        },
      },
      { upsert: true },
    )
    const saved = await Category.findOne({ slug: category.slug })
    if (saved) idBySlug.set(category.slug, saved._id.toString())
  }

  for (const template of TEMPLATES) {
    const categoryId = template.slug ? idBySlug.get(template.slug) : null
    if (template.slug && !categoryId) continue

    await CategoryTemplate.updateOne(
      { categoryId: categoryId ?? null, version: template.version },
      {
        $set: {
          categoryId: categoryId ?? null,
          isFallback: template.slug === null,
          version: template.version,
          status: TEMPLATE_STATUS.PUBLISHED,
          fieldKeys: template.fieldKeys,
          publishedAt: new Date(),
        },
      },
      { upsert: true },
    )
  }

  return idBySlug
}
