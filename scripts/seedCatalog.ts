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

  /* --- dùng chung Đồ điện tử + Xe cộ --- */
  // `YEAR` chứ không `NUMBER`: FE dựng dropdown năm thay vì ô nhập tự do, nên không có ai gõ
  // được "20223" rồi lọt qua mọi bộ lọc theo khoảng.
  {
    key: 'manufactureYear',
    label: 'Năm sản xuất',
    type: FIELD_TYPE.YEAR,
    min: 1990,
    filterable: true,
  },

  /* --- riêng Đồ điện tử --- */
  {
    key: 'deviceType',
    label: 'Loại thiết bị',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['laptop', 'Laptop'],
      ['tablet', 'Máy tính bảng'],
      ['desktop', 'PC / Máy bàn'],
      ['monitor', 'Màn hình'],
      ['tv', 'Tivi'],
      ['audio', 'Âm thanh / Tai nghe / Loa'],
      ['camera', 'Máy ảnh / Máy quay'],
      ['smartwatch', 'Đồng hồ thông minh'],
      ['console', 'Máy chơi game'],
      ['component', 'Linh kiện'],
      ['accessory', 'Phụ kiện'],
      ['other', 'Khác'],
    ),
  },
  {
    key: 'specs',
    label: 'Cấu hình',
    type: FIELD_TYPE.TEXTAREA,
    filterable: false,
    placeholder: 'VD: i5-1135G7 / 16GB RAM / 512GB SSD',
  },
  {
    key: 'screenSize',
    label: 'Kích thước màn hình',
    type: FIELD_TYPE.NUMBER,
    unit: 'inch',
    min: 1,
    filterable: true,
  },

  /* --- riêng Bất động sản --- */
  {
    key: 'listingType',
    label: 'Nhu cầu',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(['sale', 'Cần bán'], ['rent', 'Cho thuê'], ['transfer', 'Sang nhượng']),
  },
  {
    key: 'propertyType',
    label: 'Loại hình',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['apartment', 'Căn hộ / Chung cư'],
      ['house', 'Nhà riêng'],
      ['townhouse', 'Nhà mặt phố'],
      ['villa', 'Biệt thự'],
      ['land', 'Đất nền'],
      ['room', 'Phòng trọ'],
      ['office', 'Văn phòng'],
      ['shophouse', 'Shophouse / Mặt bằng KD'],
      ['warehouse', 'Kho / Xưởng'],
      ['other', 'Khác'],
    ),
  },
  {
    key: 'area',
    label: 'Diện tích',
    type: FIELD_TYPE.NUMBER,
    unit: 'm²',
    min: 1,
    filterable: true,
  },
  { key: 'bedrooms', label: 'Số phòng ngủ', type: FIELD_TYPE.NUMBER, min: 0, filterable: true },
  { key: 'bathrooms', label: 'Số phòng tắm', type: FIELD_TYPE.NUMBER, min: 0, filterable: true },
  { key: 'floors', label: 'Số tầng', type: FIELD_TYPE.NUMBER, min: 1, filterable: false },
  {
    key: 'direction',
    label: 'Hướng',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['east', 'Đông'],
      ['west', 'Tây'],
      ['south', 'Nam'],
      ['north', 'Bắc'],
      ['north_east', 'Đông Bắc'],
      ['north_west', 'Tây Bắc'],
      ['south_east', 'Đông Nam'],
      ['south_west', 'Tây Nam'],
    ),
  },
  {
    key: 'legalStatus',
    label: 'Giấy tờ pháp lý',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['certificate', 'Sổ đỏ / Sổ hồng'],
      ['sale_contract', 'Hợp đồng mua bán'],
      ['waiting', 'Đang chờ sổ'],
      ['handwritten', 'Giấy tờ viết tay'],
      ['other', 'Khác'],
    ),
  },
  {
    key: 'furniture',
    label: 'Nội thất',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(['full', 'Đầy đủ'], ['basic', 'Cơ bản'], ['none', 'Không nội thất']),
  },
  {
    key: 'frontageWidth',
    label: 'Mặt tiền',
    type: FIELD_TYPE.NUMBER,
    unit: 'm',
    min: 0,
    filterable: false,
  },
  {
    key: 'roadWidth',
    label: 'Đường vào',
    type: FIELD_TYPE.NUMBER,
    unit: 'm',
    min: 0,
    filterable: false,
  },
  {
    key: 'projectName',
    label: 'Thuộc dự án',
    type: FIELD_TYPE.TEXT,
    filterable: false,
    placeholder: 'Bỏ trống nếu không thuộc dự án',
  },

  /* --- riêng Xe cộ --- */
  {
    key: 'vehicleType',
    label: 'Loại xe',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['motorbike_manual', 'Xe máy số'],
      ['motorbike_scooter', 'Xe tay ga'],
      ['motorbike_clutch', 'Xe côn tay / Mô tô'],
      ['electric_bike', 'Xe máy điện / Xe đạp điện'],
      ['bicycle', 'Xe đạp'],
      ['car', 'Ô tô'],
      ['truck', 'Xe tải'],
      ['other', 'Khác'],
    ),
  },
  {
    key: 'mileage',
    label: 'Số km đã đi',
    type: FIELD_TYPE.NUMBER,
    unit: 'km',
    min: 0,
    filterable: true,
  },
  {
    key: 'fuelType',
    label: 'Nhiên liệu',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['gasoline', 'Xăng'],
      ['diesel', 'Dầu'],
      ['electric', 'Điện'],
      ['hybrid', 'Hybrid'],
    ),
  },
  {
    key: 'transmission',
    label: 'Hộp số',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['manual', 'Số sàn'],
      ['automatic', 'Số tự động'],
      ['cvt', 'CVT'],
      ['semi_auto', 'Bán tự động'],
    ),
  },
  {
    key: 'engineCapacity',
    label: 'Dung tích xy-lanh',
    type: FIELD_TYPE.NUMBER,
    unit: 'cc',
    min: 0,
    filterable: true,
  },
  { key: 'seats', label: 'Số chỗ ngồi', type: FIELD_TYPE.NUMBER, min: 1, filterable: true },
  {
    key: 'plateProvince',
    label: 'Biển số tỉnh',
    type: FIELD_TYPE.TEXT,
    filterable: true,
    placeholder: 'VD: 29 - Hà Nội',
  },
  {
    key: 'ownership',
    label: 'Tình trạng sở hữu',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['original_owner', 'Chính chủ'],
      ['resold', 'Đã sang tên nhiều đời'],
      ['no_papers', 'Không giấy tờ'],
    ),
  },
  { key: 'inspectionUntil', label: 'Đăng kiểm đến', type: FIELD_TYPE.TEXT, filterable: false },

  /* --- riêng Đồ gia dụng --- */
  {
    key: 'applianceType',
    label: 'Loại đồ',
    type: FIELD_TYPE.SELECT,
    filterable: true,
    options: opts(
      ['refrigerator', 'Tủ lạnh'],
      ['washing_machine', 'Máy giặt'],
      ['air_conditioner', 'Điều hòa'],
      ['fan', 'Quạt / Máy lọc không khí'],
      ['water_heater', 'Bình nóng lạnh'],
      ['kitchen', 'Thiết bị nhà bếp'],
      ['cleaning', 'Máy hút bụi / Vệ sinh'],
      ['furniture', 'Nội thất'],
      ['other', 'Khác'],
    ),
  },
  {
    key: 'capacity',
    label: 'Dung tích / Công suất',
    type: FIELD_TYPE.TEXT,
    filterable: true,
    placeholder: 'VD: 180L / 8kg / 1.5HP',
  },
  {
    key: 'power',
    label: 'Điện năng',
    type: FIELD_TYPE.NUMBER,
    unit: 'W',
    min: 0,
    filterable: false,
  },
  {
    key: 'usageDuration',
    label: 'Đã dùng bao lâu',
    type: FIELD_TYPE.TEXT,
    filterable: true,
    placeholder: 'VD: đã dùng 2 năm',
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

/*
 * `filterable` = field ngăn lọc của app dựng ra, KHÔNG phải "field quan trọng". Ngăn lọc dựng
 * thẳng từ cờ này nên mở hết là một cột dài hơn màn hình — giữ ở mức người mua thật sự thu hẹp
 * bằng (hãng, dung lượng, diện tích), tắt những field chỉ để mô tả (màu, hướng nhà, nội thất).
 *
 * Cùng một `key` có thể mở ở danh mục này mà tắt ở danh mục kia: `override.options` làm tập giá
 * trị khác hẳn nhau (xem `repairHistory` của Xe cộ), nên mỗi template tự quyết, không đồng bộ.
 */
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
    /*
     * v2: chia hai nhóm "Máy của bạn" / "Tình trạng máy" (FE in tiêu đề nhóm), thêm `ram` +
     * `origin`, và `color` đổi từ ô gõ tay sang danh sách màu chuẩn — FE vẽ chấm màu theo
     * NHÃN, mà nhãn gõ tay thì "Đen"/"đen "/"mau den" không bao giờ khớp bảng màu.
     * v1 giữ nguyên trong DB cho tin đã đăng (form sửa ghim version cũ).
     */
    slug: 'dien-thoai',
    version: 2,
    fieldKeys: [
      {
        key: 'brand',
        order: 10,
        required: true,
        filterable: true,
        group: 'Máy của bạn',
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
      { key: 'model', order: 20, required: true, group: 'Máy của bạn' },
      { key: 'ram', order: 30, required: false, filterable: true, group: 'Máy của bạn' },
      { key: 'storage', order: 40, required: true, filterable: true, group: 'Máy của bạn' },
      {
        key: 'color',
        order: 50,
        required: false,
        group: 'Máy của bạn',
        override: {
          type: FIELD_TYPE.SELECT,
          options: opts(
            ['black', 'Đen'],
            ['white', 'Trắng'],
            ['silver', 'Bạc'],
            ['gold', 'Vàng'],
            ['pink', 'Hồng'],
            ['blue', 'Xanh dương'],
            ['green', 'Xanh lá'],
            ['purple', 'Tím'],
            ['red', 'Đỏ'],
            ['titan_natural', 'Titan tự nhiên'],
            ['gray', 'Xám'],
          ),
        },
      },
      {
        key: 'batteryHealth',
        order: 60,
        required: false,
        filterable: false,
        group: 'Tình trạng máy',
      },
      { key: 'origin', order: 70, required: false, group: 'Tình trạng máy' },
      // `required` có chủ ý: đây là thông tin người mua quan tâm nhất và là chỗ hay bị giấu.
      {
        key: 'repairHistory',
        order: 80,
        required: true,
        filterable: true,
        group: 'Tình trạng máy',
      },
      { key: 'warranty', order: 90, required: false, filterable: true, group: 'Tình trạng máy' },
      {
        key: 'warrantyUntil',
        order: 100,
        required: false,
        showIf: { key: 'warranty', eq: true },
        group: 'Tình trạng máy',
      },
      { key: 'accessories', order: 110, required: false, group: 'Phụ kiện' },
    ],
  },

  /*
   * Bốn template dưới đây dùng lại từ điển ở trên là chính. `override` CHỈ xuất hiện ở chỗ
   * cùng một field mang nghĩa khác theo danh mục — `brand` là ca kinh điển: mỗi ngành một
   * danh sách hãng. Field chỉ một danh mục dùng (`deviceType`, `area`, `mileage`…) thì
   * `type`/`unit`/`options` nằm ở từ điển, không nhét vào override.
   *
   * Lưu ý hợp đồng: `ITemplateField.override` chỉ nhận `type · options · placeholder ·
   * helpText · label`. **KHÔNG có `unit`** — nhét `unit` vào đây thì Mongoose lặng lẽ bỏ nó
   * và ô nhập mất đơn vị mà không ai báo. Đơn vị luôn thuộc về từ điển.
   */
  {
    slug: 'do-dien-tu',
    version: 1,
    fieldKeys: [
      { key: 'deviceType', order: 10, required: true, filterable: true },
      {
        key: 'brand',
        order: 20,
        required: true,
        filterable: true,
        override: {
          type: FIELD_TYPE.SELECT,
          options: opts(
            ['apple', 'Apple'],
            ['samsung', 'Samsung'],
            ['sony', 'Sony'],
            ['lg', 'LG'],
            ['dell', 'Dell'],
            ['hp', 'HP'],
            ['lenovo', 'Lenovo'],
            ['asus', 'ASUS'],
            ['acer', 'Acer'],
            ['msi', 'MSI'],
            ['xiaomi', 'Xiaomi'],
            ['canon', 'Canon'],
            ['nikon', 'Nikon'],
            ['jbl', 'JBL'],
            ['other', 'Khác'],
          ),
        },
      },
      { key: 'model', order: 30, required: true, override: { placeholder: 'VD: MacBook Air M2' } },
      { key: 'specs', order: 40, required: false },
      { key: 'screenSize', order: 50, required: false, filterable: false },
      { key: 'manufactureYear', order: 60, required: false, filterable: false },
      { key: 'origin', order: 70, required: false },
      { key: 'accessories', order: 80, required: false },
      { key: 'repairHistory', order: 90, required: true, filterable: true },
      { key: 'warranty', order: 100, required: false, filterable: true },
      { key: 'warrantyUntil', order: 110, required: false, showIf: { key: 'warranty', eq: true } },
    ],
  },

  {
    slug: 'bat-dong-san',
    version: 1,
    fieldKeys: [
      { key: 'listingType', order: 10, required: true, filterable: true },
      { key: 'propertyType', order: 20, required: true, filterable: true },
      { key: 'area', order: 30, required: true, filterable: true },
      { key: 'bedrooms', order: 40, required: false, filterable: true },
      { key: 'bathrooms', order: 50, required: false, filterable: false },
      { key: 'floors', order: 60, required: false },
      { key: 'direction', order: 70, required: false, filterable: false },
      { key: 'legalStatus', order: 80, required: true, filterable: true },
      { key: 'furniture', order: 90, required: false, filterable: false },
      { key: 'frontageWidth', order: 100, required: false },
      { key: 'roadWidth', order: 110, required: false },
      { key: 'projectName', order: 120, required: false },
    ],
  },

  {
    slug: 'xe-co',
    version: 1,
    fieldKeys: [
      { key: 'vehicleType', order: 10, required: true, filterable: true },
      {
        key: 'brand',
        order: 20,
        required: true,
        filterable: true,
        override: {
          type: FIELD_TYPE.SELECT,
          options: opts(
            ['honda', 'Honda'],
            ['yamaha', 'Yamaha'],
            ['suzuki', 'Suzuki'],
            ['piaggio', 'Piaggio'],
            ['sym', 'SYM'],
            ['vinfast', 'VinFast'],
            ['toyota', 'Toyota'],
            ['hyundai', 'Hyundai'],
            ['kia', 'KIA'],
            ['mazda', 'Mazda'],
            ['ford', 'Ford'],
            ['mitsubishi', 'Mitsubishi'],
            ['mercedes', 'Mercedes-Benz'],
            ['bmw', 'BMW'],
            ['other', 'Khác'],
          ),
        },
      },
      { key: 'model', order: 30, required: true, override: { placeholder: 'VD: Vision 2019' } },
      { key: 'manufactureYear', order: 40, required: true, filterable: true },
      { key: 'mileage', order: 50, required: true, filterable: true },
      { key: 'fuelType', order: 60, required: false, filterable: false },
      { key: 'transmission', order: 70, required: false, filterable: true },
      { key: 'engineCapacity', order: 80, required: false, filterable: false },
      { key: 'seats', order: 90, required: false, filterable: false },
      { key: 'color', order: 100, required: false },
      { key: 'plateProvince', order: 110, required: false, filterable: false },
      { key: 'ownership', order: 120, required: true, filterable: true },
      {
        key: 'repairHistory',
        order: 130,
        required: true,
        filterable: false,
        // Từ điển đang mang lựa chọn của điện thoại ("Đã thay màn hình", "Đã thay pin") — vô
        // nghĩa với xe. Cùng một câu hỏi, khác hẳn tập câu trả lời.
        override: {
          options: opts(
            ['original', 'Nguyên bản, chưa sửa'],
            ['painted', 'Đã sơn lại'],
            ['engine', 'Đã bổ máy / thay máy'],
            ['accident', 'Từng va chạm'],
            ['multiple', 'Đã sửa nhiều hạng mục'],
          ),
        },
      },
      {
        key: 'accessories',
        order: 140,
        required: false,
        override: {
          options: opts(
            ['helmet', 'Mũ bảo hiểm'],
            ['spare_key', 'Chìa khoá dự phòng'],
            ['papers', 'Giấy tờ xe'],
            ['topbox', 'Thùng / Baga'],
            ['invoice', 'Hoá đơn'],
          ),
        },
      },
      {
        key: 'inspectionUntil',
        order: 150,
        required: false,
        showIf: { key: 'vehicleType', eq: 'car' },
      },
      { key: 'warranty', order: 160, required: false, filterable: true },
      { key: 'warrantyUntil', order: 170, required: false, showIf: { key: 'warranty', eq: true } },
    ],
  },

  {
    slug: 'do-gia-dung',
    version: 1,
    fieldKeys: [
      { key: 'applianceType', order: 10, required: true, filterable: true },
      {
        key: 'brand',
        order: 20,
        required: false,
        filterable: true,
        override: {
          type: FIELD_TYPE.SELECT,
          options: opts(
            ['panasonic', 'Panasonic'],
            ['toshiba', 'Toshiba'],
            ['samsung', 'Samsung'],
            ['lg', 'LG'],
            ['sharp', 'Sharp'],
            ['electrolux', 'Electrolux'],
            ['daikin', 'Daikin'],
            ['sunhouse', 'Sunhouse'],
            ['kangaroo', 'Kangaroo'],
            ['xiaomi', 'Xiaomi'],
            ['other', 'Khác'],
          ),
        },
      },
      { key: 'model', order: 30, required: false, override: { placeholder: 'VD: NR-BL340' } },
      { key: 'capacity', order: 40, required: false, filterable: false },
      { key: 'power', order: 50, required: false },
      { key: 'usageDuration', order: 60, required: false, filterable: false },
      { key: 'quantity', order: 70, required: false },
      { key: 'origin', order: 80, required: false },
      {
        key: 'repairHistory',
        order: 90,
        required: false,
        filterable: false,
        override: {
          options: opts(
            ['original', 'Nguyên bản, chưa sửa'],
            ['serviced', 'Đã bảo dưỡng'],
            ['replaced_part', 'Đã thay linh kiện'],
            ['multiple', 'Đã sửa nhiều lần'],
          ),
        },
      },
      {
        key: 'accessories',
        order: 100,
        required: false,
        override: {
          options: opts(
            ['box', 'Hộp'],
            ['manual', 'Sách hướng dẫn'],
            ['invoice', 'Hoá đơn'],
            ['spare_part', 'Phụ kiện đi kèm'],
          ),
        },
      },
      { key: 'warranty', order: 110, required: false, filterable: true },
      { key: 'warrantyUntil', order: 120, required: false, showIf: { key: 'warranty', eq: true } },
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
