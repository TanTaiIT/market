import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { FIELD_TYPE, FieldType, TEMPLATE_STATUS, TemplateStatus } from '../../common/constants'

/*
 * Hai collection, một feature:
 *
 *   field_definitions   — TỪ ĐIỂN field. `key` là khoá toàn cục, dùng lại giữa các danh mục.
 *   category_templates  — một danh mục dùng những `key` nào, theo thứ tự nào, bắt buộc cái nào.
 *
 * Tách đôi chứ không nhúng field vào template: `brand` xuất hiện ở gần như mọi danh mục, nhúng
 * là 7 bản sao của cùng một định nghĩa và lần sửa `label` sau chỉ chạm được một bản.
 *
 * KHÔNG gắn `tenantPlugin` — cùng ngoại lệ đã duyệt với `Category` (multi-tenant.convention
 * §1.3): template là từ điển dùng chung toàn hệ thống, không mang dữ liệu của khách hàng nào.
 * Hệ quả: §0.6 (index prefix `organizationId`) không áp dụng, và ghi là việc của platform-admin.
 */

// ── FIELD DEFINITION ────────────────────────────────────────────────────────

/** `value` đi vào DB, `label` chỉ để hiển thị. Đổi `label` an toàn; đổi `value` là hỏng dữ liệu cũ. */
interface IFieldOption {
  value: string
  label: string
}

export interface IFieldDefinition {
  /** camelCase, KHÔNG BAO GIỜ đổi sau khi publish — nó là khoá trong `Listing.attributes`. */
  key: string
  label: string
  type: FieldType
  unit?: string
  min?: number
  max?: number
  /**
   * Field này có được dùng để LỌC không. Mỗi `true` là một phần tử thêm vào `Listing.attrs`
   * và một nhánh index phải quét — bật bừa là phình index trên M0 512 MB mà không ai lọc.
   */
  filterable: boolean
  options: IFieldOption[]
  placeholder?: string
  helpText?: string
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IFieldDefinitionDocument extends IFieldDefinition, Document {
  _id: Types.ObjectId
}

const fieldOptionSchema = new Schema<IFieldOption>(
  {
    // snake_case ASCII: `value` nằm trong query string của bộ lọc và trong index — dấu tiếng
    // Việt ở đó là encode/decode ở mọi tầng, đổi lại không được gì.
    value: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { _id: false },
)

const fieldDefinitionSchema = new Schema<IFieldDefinitionDocument>(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    // enum lặp lại tầng zod là cố ý: seed/migration ghi thẳng qua Mongoose, không đi qua
    // `validate()`, nên đây là chốt chặn duy nhất cho các lối ghi không phải HTTP.
    type: { type: String, required: true, enum: Object.values(FIELD_TYPE) },
    unit: { type: String, trim: true, maxlength: 16 },
    min: { type: Number },
    max: { type: Number },
    filterable: { type: Boolean, default: false },
    options: { type: [fieldOptionSchema], default: [] },
    placeholder: { type: String, trim: true, maxlength: 120 },
    helpText: { type: String, trim: true, maxlength: 200 },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        return r
      },
    },
  },
)

fieldDefinitionSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// ── CATEGORY TEMPLATE ───────────────────────────────────────────────────────

/**
 * Điều kiện hiện field. `eq` cho một giá trị, `in` cho nhiều — cùng một field không dùng cả hai.
 * Cố tình KHÔNG có `and`/`or` lồng nhau: điều kiện phức tạp tới mức đó nghĩa là danh mục nên
 * tách đôi, và một mini-DSL thì FE lẫn BE đều phải cài lại y hệt nhau (đặc tả §5.5 + §5.4).
 */
interface IShowIf {
  key: string
  eq?: string | number | boolean
  in?: string[]
}

/**
 * Một field ĐƯỢC DÙNG trong template. Không phải bản sao của `FieldDefinition` — chỉ trỏ tới
 * nó bằng `key` cộng phần thuộc về NGỮ CẢNH danh mục này (thứ tự, bắt buộc, nhóm, điều kiện).
 */
export interface ITemplateField {
  key: string
  /** Đánh cách nhau 10 để sau chèn giữa được mà không phải đánh số lại cả template. */
  order: number
  required: boolean
  /**
   * Ghi đè `filterable` của từ điển cho riêng danh mục này. `undefined` = theo từ điển —
   * KHÁC `false`, nên đừng để mặc định thành boolean.
   */
  filterable?: boolean
  group?: string
  showIf?: IShowIf
  /** Ghi đè hẹp: đổi `type`/`options`/`placeholder` cho riêng danh mục (vd `brand` thành dropdown). */
  override?: Partial<
    Pick<IFieldDefinition, 'type' | 'options' | 'placeholder' | 'helpText' | 'label'>
  >
}

export interface ICategoryTemplate {
  /** `null` KHI VÀ CHỈ KHI `isFallback` — bản chung không thuộc danh mục nào. */
  categoryId: Types.ObjectId | null
  isFallback: boolean
  version: number
  status: TemplateStatus
  fieldKeys: ITemplateField[]
  publishedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ICategoryTemplateDocument extends ICategoryTemplate, Document {
  _id: Types.ObjectId
}

const showIfSchema = new Schema<IShowIf>(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    // `Mixed` vì điều kiện so được với cả `true` (warranty) lẫn chuỗi (listingType).
    eq: { type: Schema.Types.Mixed },
    in: { type: [String], default: undefined },
  },
  { _id: false },
)

const templateFieldSchema = new Schema<ITemplateField>(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    order: { type: Number, required: true },
    required: { type: Boolean, default: false },
    // Không `default: false` — `undefined` nghĩa là "theo từ điển", một nghĩa thứ ba mà
    // boolean có default không diễn đạt được.
    filterable: { type: Boolean },
    group: { type: String, trim: true, maxlength: 60 },
    showIf: { type: showIfSchema, default: undefined },
    override: { type: Schema.Types.Mixed },
  },
  { _id: false },
)

const categoryTemplateSchema = new Schema<ICategoryTemplateDocument>(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    isFallback: { type: Boolean, default: false },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(TEMPLATE_STATUS),
      default: TEMPLATE_STATUS.DRAFT,
    },
    fieldKeys: { type: [templateFieldSchema], default: [] },
    publishedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        return r
      },
    },
  },
)

// Bản chung, tra khi danh mục chưa có template riêng. `partialFilterExpression` giữ index
// chỉ gồm đúng vài bản fallback thay vì mọi template.
categoryTemplateSchema.index(
  { version: -1 },
  { partialFilterExpression: { isFallback: true, deletedAt: null } },
)
/*
 * Một danh mục không được có hai bản cùng version — seed idempotent upsert theo đúng cặp này.
 *
 * Index này phục vụ LUÔN truy vấn nóng "bản mới nhất của danh mục" (`sort({ version: -1 })`):
 * `categoryId` là equality prefix nên Mongo quét ngược phần `version` được. Một index
 * `{ categoryId: 1, version: -1 }` riêng cho việc đó là bản sao thừa, chỉ tốn chi phí ghi.
 */
categoryTemplateSchema.index(
  { categoryId: 1, version: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

function excludeDeleted(this: mongoose.Query<unknown, unknown>, next: () => void) {
  if (!this.getOptions().withDeleted) {
    this.where({ deletedAt: null })
  }
  next()
}

fieldDefinitionSchema.pre(/^find/, excludeDeleted)
// `countDocuments` KHÔNG khớp /^find/ (AGENT §10) — seed đếm để biết đã có bản chưa.
fieldDefinitionSchema.pre('countDocuments', excludeDeleted)
categoryTemplateSchema.pre(/^find/, excludeDeleted)
categoryTemplateSchema.pre('countDocuments', excludeDeleted)

export const FieldDefinition: Model<IFieldDefinitionDocument> =
  mongoose.model<IFieldDefinitionDocument>('FieldDefinition', fieldDefinitionSchema)

export const CategoryTemplate: Model<ICategoryTemplateDocument> =
  mongoose.model<ICategoryTemplateDocument>('CategoryTemplate', categoryTemplateSchema)
