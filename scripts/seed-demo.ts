/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { hash } from '@node-rs/bcrypt'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { generateJoinCode } from '../src/common/utils/joinCode'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { assertDisposableDb } from './assertDisposableDb'
import { upsertCatalog, CATEGORIES, FIELD_DEFS, TEMPLATES } from './seedCatalog'
import { User } from '../src/features/user/user.model'
import { Organization } from '../src/features/organization/organization.model'
import { OrgUnit } from '../src/features/org-unit/org-unit.model'
import { Membership } from '../src/features/membership/membership.model'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { JoinRequest } from '../src/features/join-request/join-request.model'
import { UserTrust } from '../src/features/trust/trust.model'
import { Listing } from '../src/features/listing/listing.model'
import { Favorite } from '../src/features/favorite/favorite.model'
import { Notification } from '../src/features/notification/notification.model'
import { Conversation, Message } from '../src/features/chat/chat.model'
import { CategoryTemplate } from '../src/features/category-template/category-template.model'
import { INITIAL_TRUST } from '../src/features/trust/trust.policy'
import {
  GENDER,
  JOIN_REQUEST_STATUS,
  JOINED_VIA,
  LISTING_CONDITION,
  LISTING_STATUS,
  MEMBERSHIP_ROLES,
  ORG_CAPABILITY_PRESETS,
  ORG_TYPES,
  POST_VISIBILITY,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  VnProvinceName,
  wardsOf,
} from '../src/common/constants'

/**
 * Dựng bộ dữ liệu demo: 20 tài khoản · 10 danh mục + template · 10 nhóm · 200 tin đăng.
 *
 * Khác `seed.ts` (bộ fixture nhỏ để chạy thử luồng) ở MỤC ĐÍCH: đây là dữ liệu để NHÌN — đủ
 * dày để mọi màn hình có thứ để bày, mọi bộ lọc có thứ để lọc, mọi hàng đợi duyệt có thứ để
 * duyệt. Vì thế nó không tự bịa ra từ điển danh mục mà gọi thẳng `upsertCatalog()`, cùng
 * nguồn với `seed-templates.ts`: một bộ dữ liệu demo mô tả sai hình dạng thật của template
 * thì mọi kết luận rút ra từ nó đều sai theo.
 *
 * KHÔNG xoá sạch database (việc đó là của `reset:keep-master`). Nó chỉ dọn ĐÚNG những gì
 * chính nó tạo ra — nhận diện bằng khoá tự nhiên (`SEED_EMAILS`, `GROUPS[].slug`) — nên chạy
 * lại nhiều lần vẫn ra cùng một trạng thái mà không đụng tới dữ liệu ai khác đang dùng.
 *
 * Chạy: npm run reset:keep-master && npm run seed:demo
 */

/**
 * Mật khẩu dev dùng chung — trùng với `PASSWORD` của `migrate-password.ts`, xem ghi chú ở đó
 * về việc vì sao hai file khai riêng thay vì import lẫn nhau. Sửa một chỗ thì sửa nốt chỗ kia.
 */
const PASSWORD = 'abcd@1234'
const BCRYPT_ROUNDS = 12
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

/** Số tin mỗi danh mục — nhân với 10 danh mục ra tổng số tin của bộ demo. */
const LISTINGS_PER_CATEGORY = 20

// ── 20 TÀI KHOẢN ────────────────────────────────────────────────────────────

/**
 * `key` vừa là phần đầu email (`tai@gmail.com`) vừa là hạt giống cho ảnh đại diện — một chuỗi
 * cho cả hai để nhìn email là đoán ra được mọi thứ còn lại của tài khoản đó khi debug.
 */
const PEOPLE = [
  { key: 'tai', name: 'Nguyễn Văn Tài', gender: GENDER.MALE },
  { key: 'hai', name: 'Trần Thanh Hải', gender: GENDER.MALE },
  { key: 'dat', name: 'Lê Tiến Đạt', gender: GENDER.MALE },
  { key: 'minh', name: 'Phạm Nhật Minh', gender: GENDER.MALE },
  { key: 'lan', name: 'Vũ Ngọc Lan', gender: GENDER.FEMALE },
  { key: 'huy', name: 'Đặng Quang Huy', gender: GENDER.MALE },
  { key: 'nam', name: 'Bùi Hoài Nam', gender: GENDER.MALE },
  { key: 'trang', name: 'Đỗ Thùy Trang', gender: GENDER.FEMALE },
  { key: 'khoa', name: 'Hoàng Đăng Khoa', gender: GENDER.MALE },
  { key: 'thao', name: 'Ngô Phương Thảo', gender: GENDER.FEMALE },
  { key: 'phuc', name: 'Dương Hồng Phúc', gender: GENDER.MALE },
  { key: 'linh', name: 'Lý Khánh Linh', gender: GENDER.FEMALE },
  { key: 'quan', name: 'Trịnh Minh Quân', gender: GENDER.MALE },
  { key: 'ngan', name: 'Cao Kim Ngân', gender: GENDER.FEMALE },
  { key: 'son', name: 'Mai Trường Sơn', gender: GENDER.MALE },
  { key: 'mai', name: 'Phan Tuyết Mai', gender: GENDER.FEMALE },
  { key: 'dung', name: 'Tạ Anh Dũng', gender: GENDER.MALE },
  { key: 'hoa', name: 'Chu Thanh Hoa', gender: GENDER.FEMALE },
  { key: 'tuan', name: 'Võ Minh Tuấn', gender: GENDER.MALE },
  { key: 'yen', name: 'Hồ Hải Yến', gender: GENDER.FEMALE },
] as const

const SEED_EMAILS = PEOPLE.map((p) => `${p.key}@gmail.com`)

// ── 10 NHÓM ─────────────────────────────────────────────────────────────────

interface GroupSeed {
  name: string
  slug: string
  orgType: (typeof ORG_TYPES)[keyof typeof ORG_TYPES]
  provinceCode: VnProvinceName
  description: string
  /** Từ khoá ảnh bìa/đại diện — xem `photo()`. */
  photo: string
  /** Nhóm con. Rỗng = org phẳng; chỉ org có `capabilities.hasUnits` mới được đặt. */
  units: string[]
}

/**
 * Trộn đủ bốn `orgType` và cả hai hình dạng (có nhóm con / phẳng) một cách CÓ CHỦ Ý: lớp duyệt
 * phân tầng (staff nhóm con → quản trị nhóm) chỉ chạy được ở org có `hasUnits`, còn org phẳng
 * là đường suy biến của cùng đoạn code đó. Bộ demo toàn org phẳng thì một nửa luồng duyệt
 * không có dữ liệu nào chạm tới.
 */
const GROUPS: GroupSeed[] = [
  {
    name: 'Trường THPT Hùng Vương',
    slug: 'thpt-hung-vuong',
    orgType: ORG_TYPES.SCHOOL,
    provinceCode: 'Hồ Chí Minh',
    description: 'Chợ đồ cũ nội bộ của học sinh và cựu học sinh trường THPT Hùng Vương.',
    photo: 'school,building',
    units: ['10A1', '11A2', '12A3'],
  },
  {
    name: 'Trường THPT Cao Thắng',
    slug: 'thpt-cao-thang',
    orgType: ORG_TYPES.SCHOOL,
    provinceCode: 'Hồ Chí Minh',
    description: 'Nơi học sinh Cao Thắng trao đổi sách vở, đồ dùng học tập và xe đạp.',
    photo: 'highschool',
    units: ['10B1', '11B2'],
  },
  {
    name: 'Đại học Bách Khoa',
    slug: 'dai-hoc-bach-khoa',
    orgType: ORG_TYPES.SCHOOL,
    provinceCode: 'Hồ Chí Minh',
    description: 'Sinh viên Bách Khoa mua bán laptop, linh kiện và giáo trình.',
    photo: 'university,campus',
    units: ['Khoa CNTT', 'Khoa Cơ khí'],
  },
  {
    name: 'Công ty AhaSoft',
    slug: 'cong-ty-ahasoft',
    orgType: ORG_TYPES.COMPANY,
    provinceCode: 'Hà Nội',
    description: 'Sàn nội bộ của nhân viên AhaSoft — thanh lý thiết bị và đồ dùng cá nhân.',
    photo: 'office',
    units: ['Phòng Kỹ thuật', 'Phòng Kinh doanh'],
  },
  {
    name: 'Chung cư Vinhomes Grand Park',
    slug: 'vinhomes-grand-park',
    orgType: ORG_TYPES.COMMUNITY,
    provinceCode: 'Hồ Chí Minh',
    description: 'Cư dân Vinhomes Grand Park mua bán, cho tặng đồ trong khu.',
    photo: 'apartment',
    units: [],
  },
  {
    name: 'Hội Nhiếp ảnh Sài Gòn',
    slug: 'nhiep-anh-sai-gon',
    orgType: ORG_TYPES.COMMUNITY,
    provinceCode: 'Hồ Chí Minh',
    description: 'Sang nhượng máy ảnh, ống kính và phụ kiện giữa anh em nhiếp ảnh.',
    photo: 'camera',
    units: [],
  },
  {
    name: 'CLB Xe cổ Hà Nội',
    slug: 'clb-xe-co-ha-noi',
    orgType: ORG_TYPES.COMMUNITY,
    provinceCode: 'Hà Nội',
    description: 'Nơi trao đổi xe máy cổ, phụ tùng và đồ chơi xe của anh em thủ đô.',
    photo: 'vintage,motorcycle',
    units: [],
  },
  {
    name: 'Chợ đồ cũ Đà Nẵng',
    slug: 'cho-do-cu-da-nang',
    orgType: ORG_TYPES.GENERIC,
    provinceCode: 'Đà Nẵng',
    description: 'Chợ đồ cũ mở cho tất cả người dân Đà Nẵng — không cần là thành viên.',
    photo: 'fleamarket',
    units: [],
  },
  {
    name: 'Hội Mẹ và Bé Cần Thơ',
    slug: 'me-va-be-can-tho',
    orgType: ORG_TYPES.COMMUNITY,
    provinceCode: 'Cần Thơ',
    description: 'Các mẹ Cần Thơ pass lại đồ sơ sinh, xe đẩy, nôi cũi còn tốt.',
    photo: 'baby,stroller',
    units: [],
  },
  {
    name: 'Cộng đồng Sách cũ Huế',
    slug: 'sach-cu-hue',
    orgType: ORG_TYPES.COMMUNITY,
    provinceCode: 'Huế',
    description: 'Trao đổi và ký gửi sách cũ, truyện tranh, giáo trình tại Huế.',
    photo: 'bookshop',
    units: [],
  },
]

// ── ẢNH ─────────────────────────────────────────────────────────────────────

/**
 * Ảnh THEO CHỦ ĐỀ, không phải ảnh ngẫu nhiên.
 *
 * `picsum.photos` (bộ `seed-bulk` đang dùng) trả ảnh bất kỳ, nên một tin bán iPhone hiện ra
 * ảnh bãi biển — đủ để thấy layout, không đủ để nhìn ra app trông như thế nào khi có dữ liệu
 * thật. `loremflickr` tra Flickr theo TỪ KHOÁ nên ảnh luôn đúng chủ đề, và `lock` khoá kết
 * quả lại để hai lần chạy seed ra cùng một bộ ảnh.
 *
 * URL không phải Cloudinary: app trả nguyên vẹn (xem `displayUrl`/`squareUrl` ở FE), nên ảnh
 * hiện đúng nhưng KHÔNG được resize theo khung — bình thường với dữ liệu demo.
 */
function photo(keyword: string, lock: number, w = 800, h = 600): string {
  return `https://loremflickr.com/${w}/${h}/${keyword}?lock=${lock}`
}

/** Ảnh đại diện người dùng — `u` khoá theo tài khoản nên mỗi người một khuôn mặt cố định. */
function avatar(key: string): string {
  return `https://i.pravatar.cc/300?u=${key}`
}

// ── DANH MỤC × NỘI DUNG TIN ─────────────────────────────────────────────────

interface CategoryContent {
  /** Từ khoá ảnh của cả danh mục. */
  photo: string
  /** Khoảng giá (VND) — tin thứ i lấy một mốc trong khoảng, xem `priceOf`. */
  band: [number, number]
  titles: string[]
  /** Thuộc tính động, phải khớp template của chính danh mục này (`npm run seed:templates`). */
  attributes: (i: number) => Record<string, unknown>
}

/** Chọn phần tử theo chỉ số, lặp vòng — thay cho random để hai lần seed ra cùng dữ liệu. */
const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length]

const CONTENT: Record<string, CategoryContent> = {
  'dien-thoai': {
    photo: 'smartphone',
    band: [1_500_000, 28_000_000],
    titles: [
      'iPhone 11 64GB quốc tế',
      'iPhone 12 Pro 128GB',
      'iPhone 13 128GB đẹp keng',
      'iPhone 14 Pro Max 256GB',
      'iPhone XR 64GB pin trâu',
      'Samsung Galaxy S21 Ultra',
      'Samsung Galaxy S22 128GB',
      'Samsung Galaxy A54 5G',
      'Xiaomi Redmi Note 12',
      'Xiaomi 13T Pro 256GB',
      'OPPO Reno 8 5G',
      'OPPO Find X5 Pro',
      'Vivo V25 Pro chính hãng',
      'Realme 11 Pro 5G',
      'Google Pixel 7 128GB',
      'Google Pixel 6a',
      'Nokia G60 5G',
      'Samsung Galaxy Z Flip 4',
      'iPhone SE 2022 64GB',
      'Xiaomi Poco X5 Pro',
    ],
    attributes: (i) => ({
      brand: pick(['apple', 'samsung', 'xiaomi', 'oppo', 'vivo', 'realme', 'nokia'], i),
      model: 'Bản quốc tế',
      ram: pick(['4', '6', '8', '12'], i),
      storage: pick(['64', '128', '256', '512'], i),
      color: pick(['black', 'white', 'silver', 'gold', 'blue'], i),
      batteryHealth: 84 + (i % 15),
      origin: pick(['vn', 'imported'], i),
      repairHistory: pick(['original', 'screen', 'battery'], i),
      warranty: i % 3 === 0,
      accessories: pick(
        [
          ['box', 'charger'],
          ['charger', 'cable'],
          ['box', 'invoice'],
        ],
        i,
      ),
    }),
  },

  'do-dien-tu': {
    photo: 'laptop',
    band: [800_000, 45_000_000],
    titles: [
      'MacBook Air M1 8GB/256GB',
      'MacBook Pro 14 inch M2',
      'Dell XPS 13 9310',
      'ThinkPad X1 Carbon Gen 9',
      'Asus ROG Strix G15',
      'Acer Nitro 5 RTX 3050',
      'iPad Gen 9 64GB WiFi',
      'iPad Pro 11 inch M1',
      'Samsung Galaxy Tab S8',
      'Màn hình LG 27 inch 2K',
      'Màn hình Dell UltraSharp 24',
      'Tai nghe Sony WH-1000XM4',
      'AirPods Pro 2 chính hãng',
      'Loa JBL Charge 5',
      'Máy ảnh Canon EOS M50',
      'Máy ảnh Sony A6400 + kit',
      'SSD Samsung 980 1TB',
      'Bàn phím cơ Keychron K2',
      'Chuột Logitech MX Master 3',
      'Webcam Logitech C922 Pro',
    ],
    attributes: (i) => ({
      deviceType: pick(
        ['laptop', 'tablet', 'monitor', 'audio', 'camera', 'component', 'accessory'],
        i,
      ),
      brand: pick(['apple', 'dell', 'lenovo', 'asus', 'acer', 'sony', 'lg', 'canon', 'jbl'], i),
      model: 'Chính hãng',
      specs: 'Máy dùng cá nhân, không sửa chữa, còn nguyên tem.',
      screenSize: pick([11, 13.3, 14, 15.6, 24, 27], i),
      manufactureYear: 2019 + (i % 6),
      origin: pick(['imported', 'vn'], i),
      accessories: pick([['box', 'charger'], ['charger'], ['box', 'invoice']], i),
      repairHistory: pick(['original', 'screen', 'battery'], i),
      warranty: i % 4 === 0,
    }),
  },

  'thoi-trang': {
    photo: 'clothing',
    band: [80_000, 3_500_000],
    titles: [
      'Áo khoác denim nam form rộng',
      'Áo sơ mi trắng công sở',
      'Váy hoa nhí mùa hè',
      'Quần jeans nữ ống rộng',
      'Áo hoodie unisex nỉ bông',
      'Giày Nike Air Force 1 trắng',
      'Giày Adidas Ultraboost 22',
      'Túi xách da nữ đeo chéo',
      'Balo Herschel Little America',
      'Áo len cổ lọ dệt kim',
      'Chân váy xếp ly tennis',
      'Áo blazer nữ dáng dài',
      'Quần short kaki nam',
      'Áo thun basic cotton 100%',
      'Giày cao gót mũi nhọn 7cm',
      'Kính mát Rayban Aviator',
      'Thắt lưng da bò thật',
      'Áo dài truyền thống thêu tay',
      'Đầm dạ hội dự tiệc',
      'Dép sandal nam quai ngang',
    ],
    attributes: (i) => ({
      targetGender: pick(['male', 'female', 'unisex', 'kids'], i),
      size: pick(['s', 'm', 'l', 'xl', '38', '39', '40', '42', 'freesize'], i),
      brand: pick(['Nike', 'Adidas', 'Uniqlo', 'Zara', 'Canifa', 'Local brand'], i),
      condition: pick(['new', 'like_new', 'good', 'fair'], i),
      material: pick(['Cotton', 'Denim', 'Da bò', 'Polyester', 'Len'], i),
      color: pick(['Đen', 'Trắng', 'Be', 'Xanh navy', 'Nâu'], i),
      quantity: 1 + (i % 3),
      origin: pick(['vn', 'imported'], i),
    }),
  },

  'bat-dong-san': {
    photo: 'house',
    band: [150_000_000, 12_000_000_000],
    titles: [
      'Căn hộ 2PN Vinhomes Grand Park',
      'Nhà phố 1 trệt 2 lầu Gò Vấp',
      'Đất nền KDC Bình Chánh',
      'Căn hộ studio Quận 7 full nội thất',
      'Nhà nguyên căn hẻm xe hơi',
      'Shophouse mặt tiền khu đô thị',
      'Chung cư mini cho thuê dài hạn',
      'Đất thổ cư Củ Chi 200m2',
      'Biệt thự ven sông 3 tầng',
      'Phòng trọ cao cấp có gác lửng',
      'Officetel The Sun Avenue',
      'Nhà cấp 4 Hóc Môn sổ hồng riêng',
      'Căn hộ 3PN Masteri Thảo Điền',
      'Kho xưởng 500m2 cho thuê',
      'Mặt bằng kinh doanh mặt tiền',
      'Đất vườn Long An 1000m2',
      'Nhà mặt tiền đường lớn Tân Bình',
      'Căn hộ dịch vụ cho thuê tháng',
      'Đất nền dự án Bình Dương',
      'Penthouse view sông Sài Gòn',
    ],
    attributes: (i) => ({
      listingType: pick(['sale', 'rent', 'transfer'], i),
      propertyType: pick(
        ['apartment', 'house', 'townhouse', 'villa', 'land', 'room', 'shophouse', 'warehouse'],
        i,
      ),
      area: 28 + i * 17,
      bedrooms: 1 + (i % 4),
      bathrooms: 1 + (i % 3),
      floors: 1 + (i % 4),
      direction: pick(['east', 'west', 'south', 'north', 'south_east'], i),
      legalStatus: pick(['certificate', 'sale_contract', 'waiting', 'handwritten'], i),
      furniture: pick(['full', 'basic', 'none'], i),
      frontageWidth: 3 + (i % 6),
      roadWidth: 4 + (i % 8),
      projectName: pick(['Vinhomes Grand Park', 'Masteri Thảo Điền', 'The Sun Avenue', ''], i),
    }),
  },

  'xe-co': {
    photo: 'motorcycle',
    band: [3_000_000, 750_000_000],
    titles: [
      'Honda Wave Alpha 110 biển TP',
      'Honda Vision 2022 bản cao cấp',
      'Honda SH 150i ABS',
      'Yamaha Exciter 155 VVA',
      'Yamaha Sirius phanh đĩa',
      'Piaggio Vespa Sprint 125',
      'Honda Air Blade 125 đen nhám',
      'Suzuki Raider 150 Fi',
      'SYM Attila Elizabeth',
      'Honda Winner X 2021',
      'Toyota Vios 2019 số tự động',
      'Honda City 2020 bản RS',
      'Kia Morning 2018 số sàn',
      'Hyundai Accent 2021 AT',
      'Mazda 3 2019 Luxury',
      'Ford Ranger XLS 2020',
      'Xe đạp điện VinFast Klara S',
      'Xe đạp thể thao Giant ATX',
      'Honda Lead 125 khoá smartkey',
      'Yamaha Janus giới hạn',
    ],
    attributes: (i) => ({
      vehicleType: pick(
        ['motorbike_scooter', 'motorbike_manual', 'motorbike_clutch', 'car', 'electric_bike'],
        i,
      ),
      brand: pick(['honda', 'yamaha', 'suzuki', 'piaggio', 'sym', 'toyota', 'kia', 'mazda'], i),
      model: 'Bản tiêu chuẩn',
      manufactureYear: 2015 + (i % 10),
      mileage: 3_000 + i * 4_500,
      fuelType: pick(['gasoline', 'electric', 'diesel'], i),
      transmission: pick(['manual', 'automatic', 'cvt'], i),
      engineCapacity: pick([110, 125, 150, 155, 1500, 1800], i),
      seats: pick([2, 4, 5, 7], i),
      color: pick(['Đen', 'Trắng', 'Đỏ', 'Xanh', 'Xám'], i),
      plateProvince: pick(['59', '51', '29', '30', '43'], i),
      ownership: pick(['original_owner', 'resold'], i),
      repairHistory: pick(['original', 'painted', 'engine'], i),
      accessories: pick([['helmet', 'papers'], ['papers'], ['spare_key', 'invoice']], i),
      warranty: i % 5 === 0,
    }),
  },

  'sach-vo': {
    photo: 'book',
    band: [25_000, 900_000],
    titles: [
      'Sách giáo khoa Toán 12 bộ mới',
      'Bộ đề thi THPT Quốc gia 2025',
      'Từ điển Anh - Việt Oxford',
      'Đắc Nhân Tâm bản bìa cứng',
      'Nhà Giả Kim - Paulo Coelho',
      'Tuổi Trẻ Đáng Giá Bao Nhiêu',
      'Combo truyện Conan tập 1-30',
      'Doraemon trọn bộ 45 tập',
      'Sách luyện thi IELTS Cambridge',
      'Giáo trình Kinh tế vi mô',
      'Clean Code - Robert C. Martin',
      'Bộ sách Harry Potter 7 tập',
      'Tiếng Việt lớp 5 tập 1-2',
      'Atlat Địa lý Việt Nam',
      'Sách tham khảo Hóa học 11',
      'Truyện Kiều bản kỷ niệm',
      'Sổ tay công thức Toán cấp 3',
      'Tạp chí National Geographic',
      'Sapiens - Lược sử loài người',
      'Vở luyện chữ đẹp lớp 1',
    ],
    attributes: (i) => ({
      bookType: pick(['textbook', 'reference', 'novel', 'comic', 'skill', 'magazine'], i),
      author: pick(
        ['Nhiều tác giả', 'Paulo Coelho', 'Dale Carnegie', 'Rosie Nguyễn', 'Yuval N. Harari'],
        i,
      ),
      publisher: pick(['NXB Giáo dục', 'NXB Trẻ', 'Nhã Nam', 'Kim Đồng', 'Alpha Books'], i),
      language: pick(['vi', 'vi', 'en'], i),
      publishYear: 2015 + (i % 10),
      condition: pick(['new', 'like_new', 'good', 'fair'], i),
      quantity: 1 + (i % 5),
    }),
  },

  'do-gia-dung': {
    photo: 'refrigerator',
    band: [250_000, 22_000_000],
    titles: [
      'Tủ lạnh Panasonic 180L',
      'Máy giặt LG Inverter 8kg',
      'Điều hòa Daikin 1.5HP 2 chiều',
      'Nồi cơm điện Sharp 1.8L',
      'Bếp từ đôi Sunhouse',
      'Máy lọc nước Kangaroo 9 lõi',
      'Quạt điều hòa Daikio 60L',
      'Lò vi sóng Electrolux 23L',
      'Máy hút bụi Xiaomi cầm tay',
      'Bình nóng lạnh Ariston 20L',
      'Máy xay sinh tố Philips',
      'Nồi chiên không dầu 5.5L',
      'Ấm siêu tốc Sunhouse 1.8L',
      'Máy sấy tóc Panasonic',
      'Bàn ủi hơi nước đứng',
      'Tủ đông Sanaky 300L',
      'Máy rửa chén Bosch 12 bộ',
      'Robot hút bụi Ecovacs',
      'Bộ nồi inox 5 món Elmich',
      'Máy lọc không khí Sharp',
    ],
    attributes: (i) => ({
      applianceType: pick(
        ['refrigerator', 'washing_machine', 'air_conditioner', 'fan', 'kitchen', 'cleaning'],
        i,
      ),
      brand: pick(['panasonic', 'lg', 'sharp', 'electrolux', 'daikin', 'sunhouse', 'xiaomi'], i),
      model: 'Bản nội địa',
      capacity: pick(['180L', '8kg', '1.5HP', '23L', '300L'], i),
      power: pick([90, 350, 800, 1200, 2000], i),
      usageDuration: pick(['Đã dùng 1 năm', 'Đã dùng 2 năm', 'Đã dùng 3 năm'], i),
      quantity: 1,
      origin: pick(['vn', 'imported'], i),
      repairHistory: pick(['original', 'serviced', 'replaced_part'], i),
      accessories: pick([['box', 'manual'], ['invoice'], ['manual', 'spare_part']], i),
      warranty: i % 3 === 0,
    }),
  },

  'the-thao': {
    photo: 'football',
    band: [90_000, 15_000_000],
    titles: [
      'Giày đá bóng Nike Mercurial',
      'Vợt cầu lông Yonex Astrox 88D',
      'Tạ tay bọc cao su 10kg',
      'Thảm yoga TPE 8mm',
      'Xe đạp thể thao Giant ATX 620',
      'Giày chạy bộ Adidas Adizero',
      'Bóng đá Động Lực số 5',
      'Lều cắm trại 4 người chống mưa',
      'Túi ngủ dã ngoại mùa đông',
      'Bếp gas mini du lịch',
      'Găng tay tập gym chống trượt',
      'Dây nhảy thể dục có đếm số',
      'Kính bơi Speedo chống UV',
      'Balo leo núi 40L Deuter',
      'Ghế xếp dã ngoại gấp gọn',
      'Áo bó cơ thể thao nam',
      'Máy chạy bộ tại nhà đa năng',
      'Bàn bóng bàn gấp gọn',
      'Ván trượt skateboard gỗ phong',
      'Đèn pin cắm trại sạc USB',
    ],
    attributes: (i) => ({
      sportType: pick(
        ['football', 'badminton', 'gym', 'cycling', 'running', 'swimming', 'camping'],
        i,
      ),
      brand: pick(['Nike', 'Adidas', 'Yonex', 'Giant', 'Decathlon', 'Naturehike'], i),
      condition: pick(['new', 'like_new', 'good', 'fair'], i),
      size: pick(['m', 'l', 'xl', '40', '41', '42', 'freesize'], i),
      targetGender: pick(['male', 'female', 'unisex'], i),
      material: pick(['Nhựa PP', 'Nhôm', 'Vải dù', 'Cao su', 'Thép'], i),
      usageDuration: pick(['Mới mua', 'Đã dùng 6 tháng', 'Đã dùng 1 năm'], i),
      quantity: 1 + (i % 2),
      origin: pick(['vn', 'imported'], i),
    }),
  },

  'thu-cung': {
    photo: 'puppy',
    band: [300_000, 18_000_000],
    titles: [
      'Chó Poodle tiny 3 tháng tuổi',
      'Mèo Anh lông ngắn bicolor',
      'Chó Corgi thuần chủng có giấy',
      'Mèo Ba Tư mặt tịt',
      'Chó Husky sibir 4 tháng',
      'Vẹt Cockatiel biết huýt sáo',
      'Cá Betta halfmoon',
      'Hamster Bear thuần',
      'Thỏ Hà Lan lông mượt',
      'Chó Alaska giant',
      'Mèo Munchkin chân ngắn',
      'Chó Phốc sóc mini',
      'Chim Yến Phụng cặp',
      'Cá Koi mini nhập Nhật',
      'Hamster Winter White',
      'Chó Golden Retriever 2 tháng',
      'Mèo Xiêm mắt xanh',
      'Thỏ tai cụp Holland Lop',
      'Chó Becgie Đức thuần chủng',
      'Cá vàng Ranchu size L',
    ],
    attributes: (i) => ({
      petSpecies: pick(['dog', 'cat', 'bird', 'fish', 'rodent'], i),
      breed: pick(['Poodle', 'Anh lông ngắn', 'Corgi', 'Cockatiel', 'Betta', 'Hamster Bear'], i),
      petAge: pick(['2 tháng', '3 tháng', '6 tháng', '1 năm'], i),
      vaccinated: i % 3 !== 0,
      quantity: 1,
      origin: pick(['vn', 'imported'], i),
    }),
  },

  khac: {
    photo: 'cardboard,box',
    band: [120_000, 15_000_000],
    titles: [
      'Đàn guitar acoustic Yamaha F310',
      'Đàn piano điện Casio CDP-S110',
      'Cây cảnh bonsai để bàn',
      'Bộ cờ vua gỗ cao cấp',
      'Máy khâu mini gia đình',
      'Đồng hồ treo tường kim trôi',
      'Tranh sơn dầu khổ lớn',
      'Bộ đồ nghề sửa xe 46 món',
      'Máy khoan Bosch GSB 550',
      'Lều xông hơi tại nhà',
      'Bàn học gấp gọn cho bé',
      'Ghế công thái học lưới',
      'Đèn bàn LED chống cận',
      'Kệ sách gỗ 5 tầng',
      'Máy đo huyết áp Omron',
      'Xe đẩy em bé gấp gọn',
      'Nôi cũi gỗ thông cho bé',
      'Bộ đồ chơi Lego Classic',
      'Vali kéo du lịch 24 inch',
      'Máy ép trái cây chậm',
    ],
    attributes: (i) => ({
      condition: pick(['new', 'like_new', 'good', 'fair'], i),
      brand: pick(['Yamaha', 'Casio', 'Bosch', 'Omron', 'Lego', 'Không rõ'], i),
      usageDuration: pick(['Mới mua', 'Đã dùng 1 năm', 'Đã dùng 2 năm'], i),
      quantity: 1 + (i % 2),
      origin: pick(['vn', 'imported'], i),
      warranty: i % 4 === 0,
    }),
  },
}

// ── DẪN XUẤT ────────────────────────────────────────────────────────────────

/**
 * Field nào của danh mục này được LỌC — đọc thẳng từ template thay vì chép tay danh sách.
 *
 * `Listing.attrs` là bản phẳng chỉ gồm field `filterable` (xem `listing.model.ts`), và nó là
 * thứ duy nhất bộ lọc thuộc tính tra tới. Chép tay một danh sách thứ hai ở đây thì ngày ai đó
 * bật/tắt một cờ trong `seedCatalog`, dữ liệu demo lặng lẽ lọc ra kết quả sai.
 */
function filterableKeysOf(slug: string): Set<string> {
  const template = TEMPLATES.find((t) => t.slug === slug) ?? TEMPLATES.find((t) => t.slug === null)!
  const defByKey = new Map(FIELD_DEFS.map((f) => [f.key, f]))
  const keys = new Set<string>()
  for (const field of template.fieldKeys) {
    if (field.filterable ?? defByKey.get(field.key)?.filterable ?? false) keys.add(field.key)
  }
  return keys
}

/**
 * Một mốc giá trong khoảng của danh mục. `(i * 7) % 20` thay cho `i` để danh sách không tăng
 * dần đều — sắp theo giá mà ra đúng thứ tự đăng thì không nhìn ra bộ sắp xếp có chạy không.
 */
function priceOf(band: [number, number], i: number): number {
  const [lo, hi] = band
  const step = (hi - lo) / (LISTINGS_PER_CATEGORY - 1)
  return Math.round((lo + step * ((i * 7) % LISTINGS_PER_CATEGORY)) / 10_000) * 10_000
}

/** Slug tin: đủ để unique trong org, và đọc được khi nó nằm trong URL. */
function slugify(title: string, suffix: string): string {
  const base = title
    .normalize('NFD')
    // Dấu tiếng Việt sau `NFD` là các ký tự tổ hợp U+0300–U+036F — bỏ chúng đi là còn chữ trần.
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'd')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-|-$)/g, '')
  return `${base}-${suffix}`
}

// ── DỌN DỮ LIỆU CỦA CHÍNH SCRIPT NÀY ────────────────────────────────────────

/**
 * Xoá đúng những gì lần chạy trước của script này tạo ra, theo ĐÚNG chiều phụ thuộc.
 *
 * Không `deleteMany({})`: database này còn tài khoản master và có thể còn dữ liệu người khác
 * đang dùng. Nhưng cũng không chỉ xoá `users` + `organizations` — bỏ lại `memberships`,
 * `listings`, `favorites` là để lại hàng trăm bản ghi trỏ vào những `_id` không còn tồn tại,
 * và app sẽ hiện thẻ tin trống thay vì báo lỗi (đúng loại lỗi khó lần nhất).
 */
async function wipePreviousRun(userIds: Types.ObjectId[], orgIds: Types.ObjectId[]) {
  if (userIds.length === 0 && orgIds.length === 0) return 0

  const byUser = { $in: userIds }
  const byOrg = { $in: orgIds }
  const counts = await Promise.all([
    Listing.deleteMany({ $or: [{ seller: byUser }, { organizationId: byOrg }] }),
    Favorite.deleteMany({ userId: byUser }),
    Notification.deleteMany({ $or: [{ userId: byUser }, { organizationId: byOrg }] }),
    Message.deleteMany({ $or: [{ senderId: byUser }, { organizationId: byOrg }] }),
    Conversation.deleteMany({
      $or: [{ buyerId: byUser }, { sellerId: byUser }, { organizationId: byOrg }],
    }),
    JoinRequest.deleteMany({ $or: [{ userId: byUser }, { organizationId: byOrg }] }),
    Membership.deleteMany({ $or: [{ userId: byUser }, { organizationId: byOrg }] }),
    // Grant của org bị xoá cũng phải đi: để lại là một người vẫn "quản lý" một nhóm không tồn
    // tại, và `canAdminOrg` chỉ đọc bảng này chứ không kiểm org còn sống hay không.
    RoleGrant.deleteMany({ $or: [{ userId: byUser }, { orgId: byOrg }] }),
    UserTrust.deleteMany({ userId: byUser }),
    OrgUnit.deleteMany({ organizationId: byOrg }),
    Organization.deleteMany({ _id: byOrg }),
    User.deleteMany({ _id: byUser }),
  ])
  return counts.reduce((sum, r) => sum + r.deletedCount, 0)
}

// ── CHẠY ────────────────────────────────────────────────────────────────────

async function seedDemo() {
  assertDisposableDb('seed:demo', 'thay toàn bộ 20 tài khoản, 10 nhóm và 200 tin demo của nó')
  await mongoose.connect(env.MONGO_URI)
  console.log(`Database: ${mongoose.connection.db!.databaseName}`)

  await runUnscoped('seed:demo script', async () => {
    /*
     * Master là NGƯỜI TẠO của cả 10 nhóm (`createdBy`) và là người cấp mọi quyền
     * (`grantedBy`) — đúng đường mà `organizationService.createByMaster` đi. Không có master
     * thì hai field đó thành `null` và bộ demo mô tả sai cách nhóm ra đời.
     */
    const masterGrant = await RoleGrant.findOne({
      role: SYSTEM_ROLES.MASTER,
      scopeType: SCOPE_TYPES.SYSTEM,
      revokedAt: null,
    })
    if (!masterGrant) {
      throw new Error(
        'Không tìm thấy tài khoản master — DỪNG.\n' +
          'Chạy `npm run migrate:master` (cần MASTER_EMAIL/MASTER_PASSWORD) trước rồi chạy lại.',
      )
    }
    const masterId = masterGrant.userId

    /*
     * Chốt an toàn: nếu master lại đang dùng đúng một trong 20 email demo thì bước dọn dẹp
     * bên dưới sẽ xoá mất chính nó. Từ chối chạy thay vì "khéo léo bỏ qua" — bỏ qua nghĩa là
     * bộ demo thiếu một người mà không ai biết.
     */
    const master = await User.findById(masterId)
    if (master && SEED_EMAILS.includes(master.email)) {
      throw new Error(
        `Tài khoản master đang dùng email "${master.email}", trùng danh sách demo — DỪNG.\n` +
          'Đổi email master sang địa chỉ khác rồi chạy lại; nếu không, lượt dọn dẹp sẽ xoá master.',
      )
    }

    const previousUsers = await User.find({ email: { $in: SEED_EMAILS } })
      .setOptions({ withDeleted: true })
      .select('_id')
    const previousOrgs = await Organization.find({
      slug: { $in: GROUPS.map((g) => g.slug) },
    }).select('_id')
    const removed = await wipePreviousRun(
      previousUsers.map((u) => u._id),
      previousOrgs.map((o) => o._id),
    )
    if (removed > 0) console.log(`Dọn lượt seed trước: ${removed} document.`)

    // ── 1. Danh mục + field + template (cùng nguồn với `npm run seed:templates`) ──
    const categoryIdBySlug = await upsertCatalog()
    console.log(`Danh mục + template: ${CATEGORIES.length} danh mục, ${TEMPLATES.length} template.`)

    // ── 2. 20 tài khoản ──
    /*
     * Băm mật khẩu MỘT lần rồi `insertMany`, không `User.create` từng người: `insertMany`
     * không chạy hook `pre('save')` nên mật khẩu phải vào DB ở dạng đã băm — và bcrypt 12
     * vòng × 20 lần là ~6 giây chờ cho đúng một chuỗi giống hệt nhau.
     */
    const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS)
    const users = await User.insertMany(
      PEOPLE.map((person, i) => ({
        name: person.name,
        email: `${person.key}@gmail.com`,
        // 10 chữ số, suy từ chỉ số nên hai lần seed ra cùng số — tiện khi cần tìm lại một tài khoản.
        phone: `09${String(12_345_670 + i).padStart(8, '0')}`,
        password: passwordHash,
        avatar: avatar(person.key),
        gender: person.gender,
        // Bật để `posterContact` của tin có số thật; mặc định của hệ thống vẫn là `false`.
        showPhone: true,
        emailVerifiedAt: new Date(),
        location: { province: GROUPS[i % GROUPS.length].provinceCode },
      })),
    )
    console.log(`Tài khoản: ${users.length} (mật khẩu chung "${PASSWORD}").`)

    // Uy tín: mỗi tài khoản một hồ sơ ở mặc định hiện hành. Thiếu nó thì hồ sơ chỉ ra đời ở
    // lượt duyệt đầu tiên, và tới lúc đó bậc hiện trên app khác bậc thật của người dùng.
    await UserTrust.insertMany(users.map((u) => ({ userId: u._id, ...INITIAL_TRUST })))

    // ── 3. 10 nhóm + nhóm con + thành viên + quyền ──
    /*
     * `Organization.create` chứ không `insertMany`: hook `pre('validate')` của model mới là
     * chỗ sinh `slugNormalized` (khoá chống mạo danh) và `nameTokens` (khoá tra của ô tìm
     * nhóm). Ghi thẳng thì hai field đó rỗng và nhóm không tìm ra được bằng tên.
     */
    const orgs = await Organization.create(
      GROUPS.map((group, i) => ({
        joinCode: generateJoinCode(),
        name: group.name,
        slug: group.slug,
        orgType: group.orgType,
        capabilities: ORG_CAPABILITY_PRESETS[group.orgType],
        provinceCode: group.provinceCode,
        description: group.description,
        avatarUrl: photo(group.photo, 100 + i, 400, 400),
        coverUrl: photo(group.photo, 200 + i, 1200, 500),
        rules: [
          'Đăng đúng danh mục, ảnh thật của món đồ.',
          'Không đăng lại cùng một tin nhiều lần trong ngày.',
          'Ghi rõ tình trạng và giá — không để "inbox".',
        ],
        createdBy: masterId,
      })),
    )

    const unitsByOrg = new Map<string, Types.ObjectId[]>()
    for (const [i, group] of GROUPS.entries()) {
      if (group.units.length === 0) continue
      const created = await OrgUnit.insertMany(
        group.units.map((name) => ({ organizationId: orgs[i]._id, name })),
      )
      unitsByOrg.set(
        group.slug,
        created.map((u) => u._id),
      )
    }

    /*
     * Ai ở nhóm nào. Người thứ `i` làm CHỦ nhóm thứ `i` (10 người đầu, đúng yêu cầu), rồi mỗi
     * nhóm nhận thêm 4 thành viên theo bước nhảy nguyên tố `3/7/11/15` trên vòng 20 người.
     *
     * Bước nhảy nguyên tố chứ không phải `i+1..i+4`: bước liền kề gom 10 người cuối vào đúng
     * hai nhóm cuối, và người thứ 15 sẽ không bao giờ gặp người thứ 3 ở bất kỳ nhóm nào — bộ
     * dữ liệu trông có 10 nhóm nhưng thật ra là 10 ốc đảo.
     */
    const rosterOf = (orgIndex: number): number[] => {
      const roster = [orgIndex]
      for (const step of [3, 7, 11, 15]) {
        const member = (orgIndex + step) % PEOPLE.length
        if (!roster.includes(member)) roster.push(member)
      }
      return roster
    }

    const memberships: Record<string, unknown>[] = []
    const grants: Record<string, unknown>[] = []
    for (const [orgIndex, group] of GROUPS.entries()) {
      const org = orgs[orgIndex]
      const units = unitsByOrg.get(group.slug) ?? []
      const roster = rosterOf(orgIndex)

      for (const [seat, personIndex] of roster.entries()) {
        const isAdmin = seat === 0
        memberships.push({
          userId: users[personIndex]._id,
          organizationId: org._id,
          role: isAdmin ? MEMBERSHIP_ROLES.ADMIN : MEMBERSHIP_ROLES.MEMBER,
          unitId: units.length > 0 ? units[seat % units.length] : null,
          joinedVia: isAdmin ? JOINED_VIA.ROSTER : JOINED_VIA.REQUEST,
        })
      }

      /*
       * Quyền THẬT của chủ nhóm nằm ở đây, không ở `memberships.role`.
       *
       * `role: 'admin'` chỉ là thân phận hiển thị; `canAdminOrg`/`canModerateOrg` đọc bảng
       * `role_grants`. Thiếu dòng này thì chủ nhóm đăng nhập vào thấy nhóm của mình nhưng
       * không sửa được thông tin, không duyệt được tin nào — đúng lỗi đã gặp trên UI.
       */
      grants.push({
        userId: users[roster[0]]._id,
        role: SYSTEM_ROLES.MANAGER,
        scopeType: SCOPE_TYPES.ORG,
        orgId: org._id,
        grantedBy: masterId,
      })

      // Org có nhóm con thì cấp thêm một staff cấp nhóm con — lớp duyệt phân tầng cần một
      // người ở tầng dưới mới chạy được, không thì nhánh đó không có dữ liệu nào chạm tới.
      if (units.length > 0 && roster.length > 1) {
        grants.push({
          userId: users[roster[1]]._id,
          role: SYSTEM_ROLES.STAFF,
          scopeType: SCOPE_TYPES.ORG_UNIT,
          orgId: org._id,
          unitId: units[0],
          grantedBy: masterId,
        })
      }
    }
    await Membership.insertMany(memberships)
    await RoleGrant.insertMany(grants)
    console.log(
      `Nhóm: ${orgs.length} · thành viên: ${memberships.length} · lượt cấp quyền: ${grants.length}.`,
    )

    /*
     * Mỗi nhóm một đơn xin vào đang CHỜ, từ người chưa ở trong nhóm đó — để bàn quản trị của
     * chủ nhóm có việc thật để làm ngay lần đăng nhập đầu.
     */
    await JoinRequest.insertMany(
      GROUPS.map((_group, orgIndex) => {
        // Bước nhảy 5 KHÔNG nằm trong {0,3,7,11,15} của `rosterOf`, nên người này chắc chắn
        // chưa ở trong nhóm — đơn xin vào của một thành viên hiện tại là dữ liệu tự mâu thuẫn.
        const outsider = (orgIndex + 5) % PEOPLE.length
        return {
          userId: users[outsider]._id,
          organizationId: orgs[orgIndex]._id,
          claimedName: PEOPLE[outsider].name,
          note: 'Mình muốn tham gia để mua bán đồ trong nhóm.',
          status: JOIN_REQUEST_STATUS.PENDING,
          expiresAt: new Date(NOW + 14 * DAY),
        }
      }),
    )

    // ── 4. 200 tin đăng ──
    const listings: Record<string, unknown>[] = []
    let position = 0

    for (const category of CATEGORIES) {
      const content = CONTENT[category.slug]
      if (!content) throw new Error(`Thiếu nội dung demo cho danh mục "${category.slug}"`)

      const categoryId = new Types.ObjectId(categoryIdBySlug.get(category.slug)!)
      const template = await CategoryTemplate.findOne({ categoryId }).sort({ version: -1 })
      const filterable = filterableKeysOf(category.slug)

      for (let i = 0; i < LISTINGS_PER_CATEGORY; i += 1) {
        position += 1

        /*
         * Hình dạng của 20 tin, và vì sao đúng những con số này:
         *
         *  0-10 công khai ACTIVE  — thứ khách vãng lai nhìn thấy; phải là đa số, nếu không
         *                           trang chủ trống trong khi database đầy.
         *    11 công khai SOLD    — app có nhánh riêng cho tin đã bán, cần ít nhất một tin.
         * 12-16 nội bộ  ACTIVE    — bảng tin của nhóm; rải qua các nhóm khác nhau.
         * 17-18 công khai PENDING — hàng đợi của manager danh mục.
         *    19 nội bộ  PENDING   — hàng đợi của chủ nhóm.
         */
        const isOrgPost = i >= 12 && i <= 16
        const isOrgPending = i === 19
        const inOrg = isOrgPost || isOrgPending
        const status =
          i === 11 ? LISTING_STATUS.SOLD : i >= 17 ? LISTING_STATUS.PENDING : LISTING_STATUS.ACTIVE

        // Tin nội bộ phải do NGƯỜI TRONG NHÓM đăng: người ngoài đăng vào nhóm là một luồng
        // khác hẳn (`pending_unverified`), trộn lẫn hai thứ là mô tả sai hàng đợi duyệt.
        const orgIndex = (position * 3) % GROUPS.length
        const roster = rosterOf(orgIndex)
        const org = inOrg ? orgs[orgIndex] : null
        const sellerIndex = inOrg ? roster[position % roster.length] : position % PEOPLE.length
        const seller = users[sellerIndex]

        const province = inOrg
          ? GROUPS[orgIndex].provinceCode
          : GROUPS[position % GROUPS.length].provinceCode
        const wards = wardsOf(province)
        const ward = wards[position % wards.length]

        const attributes = content.attributes(i)
        const title = content.titles[i]

        listings.push({
          organizationId: org?._id ?? null,
          visibility: inOrg ? POST_VISIBILITY.ORG_INTERNAL : POST_VISIBILITY.PUBLIC,
          // Snapshot định tuyến hàng đợi duyệt — BẮT BUỘC với tin công khai, và chỉ có nghĩa
          // ở đó: tin nội bộ do nhóm duyệt nên không có ô (danh mục × tỉnh × phường) nào.
          provinceCode: inOrg ? null : province,
          wardCode: inOrg ? null : ward,
          unitId: null,
          title,
          slug: slugify(title, String(position)),
          description:
            `${title}. Hàng dùng kỹ, còn đầy đủ chức năng, ảnh chụp thật tại nhà. ` +
            'Ưu tiên xem hàng trực tiếp, hỗ trợ ship trong khu vực.',
          price: priceOf(content.band, i),
          isNegotiable: i % 3 === 0,
          condition: pick(
            [LISTING_CONDITION.USED, LISTING_CONDITION.LIKE_NEW, LISTING_CONDITION.NEW],
            i,
          ),
          images: Array.from({ length: 1 + (i % 4) }, (_, n) =>
            photo(content.photo, position * 10 + n),
          ),
          category: categoryId,
          seller: seller._id,
          posterName: seller.name,
          posterContact: seller.phone ?? '',
          posterAvatar: seller.avatar,
          location: { province, ward },
          status,
          // Rải ngược về quá khứ nên bảng tin có thứ tự thật để sắp, thay vì 200 tin cùng giây.
          rankAt: new Date(NOW - position * 37 * 60 * 1000),
          createdAt: new Date(NOW - position * 37 * 60 * 1000),
          viewCount: (position * 13) % 400,
          // 0, không phải số ngẫu nhiên: bộ đếm này là bản cache của `favorites`, mà seed
          // không tạo dòng nào ở đó. Bịa một số vào đây là để app khoe "12 lượt lưu" cho một
          // tin không ai lưu, và mọi phép đối chiếu sau này đều lệch.
          favoriteCount: 0,
          attributes,
          // Bản phẳng để lọc — chỉ field `filterable`, đúng như service dựng lúc tạo tin thật.
          attrs: Object.entries(attributes)
            .filter(([key]) => filterable.has(key))
            .map(([k, v]) => ({ k, v })),
          // Ghim template: form sửa tin dựng lại đúng bản này, không phải bản mới nhất.
          templateRef: template
            ? { id: template._id, version: template.version, isFallback: false }
            : undefined,
          expiresAt:
            status === LISTING_STATUS.ACTIVE ? new Date(NOW + (30 + (i % 60)) * DAY) : undefined,
        })
      }
    }

    await Listing.insertMany(listings)
    console.log(
      `Tin đăng: ${listings.length} (${LISTINGS_PER_CATEGORY} tin × ${CATEGORIES.length} danh mục).`,
    )
  })

  console.log('')
  console.log('Xong. Đăng nhập bằng bất kỳ tài khoản nào dưới đây:')
  console.log(`  Chủ nhóm : ${SEED_EMAILS.slice(0, 10).join(', ')}`)
  console.log(`  Thành viên: ${SEED_EMAILS.slice(10).join(', ')}`)
  console.log(`  Mật khẩu  : ${PASSWORD}`)

  await mongoose.disconnect()
}

seedDemo().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
