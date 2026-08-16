/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose'
import { faker } from '@faker-js/faker'
import { hash } from '@node-rs/bcrypt'
import { env } from '../src/config/env'
import { User } from '../src/features/user/user.model'
import { Listing } from '../src/features/listing/listing.model'
import { Organization } from '../src/features/organization/organization.model'
import { Notification } from '../src/features/notification/notification.model'
import { Category } from '../src/features/category/category.model'
import { Membership } from '../src/features/membership/membership.model'
import { RoleGrant } from '../src/features/role-grant/role-grant.model'
import { OrgUnit } from '../src/features/org-unit/org-unit.model'
import { JoinRequest } from '../src/features/join-request/join-request.model'
import { Conversation, Message } from '../src/features/chat/chat.model'
import { Report } from '../src/features/report/report.model'
import { AuditLog } from '../src/features/moderation/moderation.model'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { assertDisposableDb } from './assertDisposableDb'
import {
  LISTING_STATUS,
  LISTING_CONDITION,
  MEMBERSHIP_ROLES,
  JOINED_VIA,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  ListingStatus,
  ListingCondition,
  VnProvinceName,
  wardsOf,
} from '../src/common/constants'

/**
 * Seed khối lượng lớn: 1000 tin đăng phủ đủ mọi biến thể mà API và app mobile phải xử lý
 * (7 trạng thái, 3 tình trạng, giá 0đ → 80 triệu, 0 → 12 ảnh, 5 tỉnh, tin đã soft-delete...).
 *
 * Khác `seed.ts`: file kia là fixture tối thiểu 15 tin để chạy thử luồng — file này để đo
 * phân trang, bộ lọc và bàn duyệt ở quy mô thật. Cả hai đều XOÁ SẠCH dữ liệu trước khi ghi.
 *
 * Topology org giữ y hệt `seed.ts` (hung-vuong, cao-thang, xyz) nên mọi tài khoản đăng nhập
 * cũ vẫn dùng được, chỉ khác là dữ liệu dày lên.
 *
 * Chạy: `npm run seed:bulk`
 */

const TOTAL_LISTINGS = 1000
const PASSWORD = 'password123'
const BCRYPT_ROUNDS = 12
const DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_DAYS = 180

// Cùng seed -> cùng dữ liệu ở mọi lần chạy: bug "chỉ tái hiện trên máy tôi" vì random khác nhau
// là thứ không đáng phải đi tìm. Đổi số này khi muốn một bộ dữ liệu khác.
faker.seed(20260813)

const NOW = Date.now()

// ── TỪ ĐIỂN DỮ LIỆU ─────────────────────────────────────────────────

const CATEGORY_SEEDS = [
  // Bốn danh mục đầu khớp bốn chip lọc mặc định bên app mobile — giữ nguyên slug/icon.
  { name: 'Sách vở', slug: 'sach-vo', icon: '📚', order: 1, isActive: true },
  { name: 'Xe đạp', slug: 'xe-dap', icon: '🚲', order: 2, isActive: true },
  { name: 'Điện tử', slug: 'dien-tu', icon: '💻', order: 3, isActive: true },
  { name: 'Đồ dùng', slug: 'do-dung', icon: '🎒', order: 4, isActive: true },
  { name: 'Nhạc cụ', slug: 'nhac-cu', icon: '🎸', order: 5, isActive: true },
  { name: 'Thể thao', slug: 'the-thao', icon: '⚽', order: 6, isActive: true },
  // Danh mục đã tắt: `GET /categories` không trả về nó, nhưng vài tin cũ vẫn trỏ vào —
  // đúng tình huống mà `category.model.ts` giải thích khi chọn tắt thay vì xoá.
  { name: 'Đồng phục cũ', slug: 'dong-phuc-cu', icon: '👕', order: 7, isActive: false },
] as const

type CategorySlug = (typeof CATEGORY_SEEDS)[number]['slug']

const CATALOG: Record<CategorySlug, { nouns: string[]; brands: string[] }> = {
  'sach-vo': {
    nouns: [
      'Sách Giải tích 1',
      'Bộ đề Vật lý 12',
      'Từ điển Anh - Việt',
      'Giáo trình Kinh tế vi mô',
      'Sách luyện thi IELTS',
      'Tuyển tập đề Hoá hữu cơ',
    ],
    brands: ['NXB Giáo Dục', 'NXB Trẻ', 'Kim Đồng', 'Nhã Nam'],
  },
  'xe-dap': {
    nouns: ['Xe đạp thể thao', 'Xe đạp mini', 'Xe đạp địa hình', 'Xe đạp gấp', 'Xe đạp học sinh'],
    brands: ['Giant', 'Asama', 'Thống Nhất', 'Fornix', 'Martin'],
  },
  'dien-tu': {
    nouns: [
      'Laptop cũ',
      'Máy tính bảng',
      'Tai nghe không dây',
      'Bàn phím cơ',
      'Chuột không dây',
      'Màn hình 24 inch',
    ],
    brands: ['Dell', 'Asus', 'Logitech', 'Samsung', 'Xiaomi'],
  },
  'do-dung': {
    nouns: ['Balo đi học', 'Bình giữ nhiệt', 'Đèn bàn học', 'Ghế xoay văn phòng', 'Kệ sách mini'],
    brands: ['Mr Vui', 'Lock&Lock', 'Rạng Đông', 'Hoà Phát'],
  },
  'nhac-cu': {
    nouns: ['Đàn guitar acoustic', 'Đàn ukulele', 'Kèn harmonica', 'Trống cajon'],
    brands: ['Yamaha', 'Rosen', 'Suzuki', 'Vines'],
  },
  'the-thao': {
    nouns: ['Vợt cầu lông', 'Giày chạy bộ', 'Bóng rổ size 7', 'Thảm tập yoga', 'Tạ tay 5kg'],
    brands: ['Yonex', 'Nike', 'Adidas', 'Lining'],
  },
  'dong-phuc-cu': {
    nouns: ['Áo đồng phục', 'Áo khoác lớp', 'Quần đồng phục nam'],
    brands: ['May Nhà Bè', 'Việt Tiến'],
  },
}

// Kiểu VnProvinceName cố ý không phải string: gõ sai tên tỉnh ở đây là lỗi typecheck,
// thay vì seed chạy trót lọt rồi bộ lọc trả rỗng lúc chạy thật.
const PROVINCES: VnProvinceName[] = ['Hồ Chí Minh', 'Hà Nội', 'Đà Nẵng', 'Cần Thơ', 'Hải Phòng']

/**
 * Lấy xã thật từ bảng hành chính thay vì bịa tên: `/listings/nearby` xếp tin cùng xã lên
 * trước, nên seed phải có nhiều tin trùng xã thì mới thử được thứ tự đó. Giới hạn 6 xã đầu
 * mỗi tỉnh để tin dồn lại chứ không rải mỏng khắp 168 xã.
 */
const WARDS_PER_PROVINCE = 6
const wardPool = (province: VnProvinceName) => wardsOf(province).slice(0, WARDS_PER_PROVINCE)

const FAMILY_NAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô']
const MIDDLE_NAMES = ['Văn', 'Thị', 'Hữu', 'Minh', 'Thanh', 'Quốc', 'Gia', 'Bảo']
const GIVEN_NAMES = [
  'An',
  'Bình',
  'Chi',
  'Dũng',
  'Giang',
  'Hà',
  'Khoa',
  'Lan',
  'Mai',
  'Nam',
  'Oanh',
  'Phúc',
  'Quân',
  'Trang',
  'Vy',
]

const DESC_OPENERS = [
  'Mình dọn phòng nên để lại',
  'Cần bán gấp',
  'Đồ nhà dùng còn tốt, nay nhượng lại',
  'Thanh lý cuối kỳ',
  'Mua về ít dùng nên bán lại',
]
const DESC_CLOSERS = [
  'Ưu tiên bạn nào lấy nhanh, xem hàng trực tiếp tại trường.',
  'Giao dịch tại cổng trường giờ hành chính.',
  'Có thể ship nội thành, phí ship bên mua chịu.',
  'Bao test thoải mái trước khi nhận.',
  'Nhắn tin trước khi qua xem giúp mình nhé.',
]

const REJECT_REASONS = [
  'Ảnh không rõ sản phẩm, vui lòng chụp lại',
  'Tiêu đề không khớp nội dung mô tả',
  'Thiếu thông tin liên hệ hợp lệ',
  'Giá đăng không hợp lý so với mô tả',
]
const HIDE_REASONS = ['Tạm ẩn theo yêu cầu người đăng', 'Ẩn chờ xác minh lại thông tin']

// ── HELPERS ─────────────────────────────────────────────────────────

/** Xác suất phần trăm, đi qua faker nên vẫn tất định theo `faker.seed`. */
const chance = (percent: number) => faker.number.int({ min: 1, max: 100 }) <= percent

const pick = <T>(items: readonly T[]): T => faker.helpers.arrayElement(items as T[])

/**
 * `faker.helpers.slugify` không bóc dấu tiếng Việt (nó chỉ bỏ ký tự lạ), nên "Sách Giải tích"
 * ra "Sch-Gii-tch". Chuẩn hoá NFD rồi cắt dấu mới cho slug đọc được.
 */
function toSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function vietnameseName(): string {
  return `${pick(FAMILY_NAMES)} ${pick(MIDDLE_NAMES)} ${pick(GIVEN_NAMES)}`
}

/**
 * Rải `total` phần tử theo tỉ lệ phần trăm rồi xáo. Làm tròn từng nhóm có thể lệch vài phần
 * tử — bù bằng nhóm đầu rồi cắt đúng `total`, nên tổng luôn khớp còn tỉ lệ chỉ xê dịch không
 * đáng kể. Số cuối cùng in ra ở bảng tổng kết là đếm từ dữ liệu thật, không phải từ bảng này.
 */
function weightedPool<T>(entries: Array<[T, number]>, total: number): T[] {
  const pool: T[] = []
  for (const [value, percent] of entries) {
    const count = Math.round((percent / 100) * total)
    for (let i = 0; i < count; i += 1) pool.push(value)
  }
  while (pool.length < total) pool.push(entries[0][0])
  return faker.helpers.shuffle(pool).slice(0, total)
}

const STATUS_MIX: Array<[ListingStatus, number]> = [
  // `active` chiếm đa số để bảng tin còn lật được nhiều trang; các trạng thái nội bộ vẫn đủ
  // dày để bàn duyệt và màn "tin của tôi" có việc mà làm.
  [LISTING_STATUS.ACTIVE, 62],
  [LISTING_STATUS.PENDING, 10],
  [LISTING_STATUS.SOLD, 9],
  [LISTING_STATUS.DRAFT, 6],
  [LISTING_STATUS.REJECTED, 5],
  [LISTING_STATUS.HIDDEN, 4],
  [LISTING_STATUS.EXPIRED, 4],
]

const CONDITION_MIX: Array<[ListingCondition, number]> = [
  [LISTING_CONDITION.USED, 50],
  [LISTING_CONDITION.LIKE_NEW, 30],
  [LISTING_CONDITION.NEW, 20],
]

/**
 * TTL index trên `expiresAt` khai `expireAfterSeconds: 0`, nghĩa là Mongo XOÁ THẬT mọi
 * document có `expiresAt` nằm trong quá khứ, trong vòng khoảng một phút.
 *
 * Vì vậy tin `expired` cố tình để TRỐNG field này thay vì set một mốc quá khứ cho "đúng
 * nghĩa": làm thế thì 40 tin vừa seed sẽ tự bốc hơi ngay sau khi script chạy xong, và người
 * đọc log sẽ đi tìm bug ở chỗ khác. Trạng thái hết hạn nằm ở `status`, không ở `expiresAt`.
 * `draft` cũng để trống — tin chưa đăng thì chưa bắt đầu đếm hạn.
 */
function expiresAtFor(status: ListingStatus): Date | undefined {
  if (status === LISTING_STATUS.EXPIRED || status === LISTING_STATUS.DRAFT) return undefined
  return new Date(NOW + faker.number.int({ min: 3, max: 90 }) * DAY_MS)
}

function priceFor(): number {
  // 3% cho 0đ: app render nhánh riêng "Miễn phí" cho mốc này (`formatPrice`), không có tin
  // giá 0 thì nhánh đó không bao giờ được chạm tới.
  if (chance(3)) return 0
  if (chance(55)) return faker.number.int({ min: 20, max: 600 }) * 1000
  if (chance(70)) return faker.number.int({ min: 600, max: 5000 }) * 1000
  return faker.number.int({ min: 5, max: 80 }) * 1_000_000
}

/** Ảnh phải là URL sống thật thì mới thấy được layout gallery — picsum ổn định theo seed. */
function imagesFor(slug: string): string[] {
  if (chance(8)) return [] // app rơi về gradient theo id khi tin không có ảnh
  const count = chance(7) ? 12 : faker.number.int({ min: 1, max: 8 })
  return Array.from({ length: count }, (_, i) => `https://picsum.photos/seed/${slug}-${i}/800/600`)
}

function attributesFor(categorySlug: CategorySlug, brand: string): Record<string, string> {
  // 10% để trống: `attributes` là Map tuỳ chọn, UI phải chịu được tin không có thuộc tính nào.
  if (chance(10)) return {}

  const year = String(faker.number.int({ min: 2016, max: 2026 }))
  switch (categorySlug) {
    case 'sach-vo':
      return { publisher: brand, year, language: 'Tiếng Việt' }
    case 'xe-dap':
      return { brand, year, size: pick(['S', 'M', 'L']) }
    case 'dien-tu':
      return { brand, year, warranty: pick(['Còn bảo hành', 'Hết bảo hành']) }
    case 'the-thao':
      return { brand, size: pick(['38', '39', '40', '41', '42']) }
    default:
      return { brand, year }
  }
}

// ── SEED USERS / ORGS ───────────────────────────────────────────────

type SeedUser = { _id: Types.ObjectId; name: string; phone: string }

type SeedOrg = {
  id: Types.ObjectId
  name: string
  slug: string
  owner: SeedUser
  moderator: SeedUser
  /** Owner + members: những người được gán làm `seller` của tin. */
  sellers: SeedUser[]
  share: number
}

const ORG_SEEDS = [
  { name: 'Trường Hùng Vương', slug: 'hung-vuong', members: 10, share: 0.45 },
  { name: 'Trường Cao Thắng', slug: 'cao-thang', members: 8, share: 0.3 },
  { name: 'Cửa hàng XYZ', slug: 'xyz', members: 6, share: 0.25 },
]

/**
 * Dựng org + toàn bộ nhân sự của nó, trả về document user dạng thô để `insertMany` một lượt.
 *
 * Hash mật khẩu được truyền vào đã băm sẵn: `insertMany` KHÔNG chạy `pre('save')` nên nếu đưa
 * plaintext vào thì mật khẩu nằm nguyên trong DB và `comparePassword` không bao giờ khớp.
 * Băm một lần rồi dùng chung cho ~30 user thay vì băm từng người — bcrypt 12 vòng tốn khoảng
 * một phần tư giây mỗi lần, nhân lên là chờ vô ích.
 */
function buildOrg(spec: (typeof ORG_SEEDS)[number], passwordHash: string) {
  const orgId = new Types.ObjectId()
  const rows: Record<string, unknown>[] = []
  const memberships: Record<string, unknown>[] = []
  const grants: Record<string, unknown>[] = []

  /**
   * Tài khoản là TOÀN CỤC: bản ghi user không mang org và không mang role. Quan hệ với org đi
   * vào `memberships`, quyền duyệt đi vào `role_grants` — đúng ba bảng mà code thật dùng.
   */
  const makeUser = (
    name: string,
    email: string,
    duty: 'owner' | 'moderator' | 'member',
  ): SeedUser => {
    const user: SeedUser = {
      _id: new Types.ObjectId(),
      name,
      phone: `09${faker.string.numeric({ length: 8 })}`,
    }
    rows.push({
      _id: user._id,
      name,
      email,
      phone: user.phone,
      password: passwordHash,
      emailVerifiedAt: new Date(),
    })
    memberships.push({
      userId: user._id,
      organizationId: orgId,
      role: duty === 'owner' ? MEMBERSHIP_ROLES.OWNER : MEMBERSHIP_ROLES.MEMBER,
      joinedVia: JOINED_VIA.ROSTER,
    })
    if (duty !== 'member') {
      grants.push({
        userId: user._id,
        role: duty === 'owner' ? SYSTEM_ROLES.MANAGER : SYSTEM_ROLES.STAFF,
        scopeType: SCOPE_TYPES.ORG,
        orgId,
      })
    }
    return user
  }

  const owner = makeUser(`Chủ ${spec.name}`, `owner@${spec.slug}.local`, 'owner')
  const moderator = makeUser(vietnameseName(), `mod@${spec.slug}.local`, 'moderator')
  const members = Array.from({ length: spec.members }, (_, i) =>
    // Email đánh số theo chỉ số chứ không theo tên: email giờ unique TOÀN CỤC, mà tên tiếng
    // Việt sinh ngẫu nhiên hoàn toàn có thể trùng nhau.
    makeUser(vietnameseName(), `member${i + 1}@${spec.slug}.local`, 'member'),
  )

  const org: SeedOrg = {
    id: orgId,
    name: spec.name,
    slug: spec.slug,
    owner,
    moderator,
    sellers: [owner, ...members],
    share: spec.share,
  }
  return { org, rows, memberships, grants }
}

// ── SEED LISTINGS ───────────────────────────────────────────────────

type ListingSeed = {
  organizationId: Types.ObjectId
  title: string
  slug: string
  description: string
  price: number
  isNegotiable: boolean
  condition: ListingCondition
  images: string[]
  category: Types.ObjectId
  seller: Types.ObjectId
  posterName: string
  posterContact: string
  location: {
    address: string
    province: VnProvinceName
    ward: string
  }
  status: ListingStatus
  viewCount: number
  favoriteCount: number
  attributes: Record<string, string>
  moderation?: { reason: string; byUserId: Types.ObjectId; byName: string; at: Date }
  expiresAt?: Date
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

let slugCounter = 0

function buildListing(
  org: SeedOrg,
  categories: Map<CategorySlug, Types.ObjectId>,
  status: ListingStatus,
  condition: ListingCondition,
): ListingSeed {
  // Danh mục đã tắt chỉ nhận rất ít tin — nó là ngoại lệ cần có mẫu, không phải danh mục thường.
  const categorySlug: CategorySlug = chance(2)
    ? 'dong-phuc-cu'
    : pick(['sach-vo', 'xe-dap', 'dien-tu', 'do-dung', 'nhac-cu', 'the-thao'] as const)

  const catalog = CATALOG[categorySlug]
  const brand = pick(catalog.brands)
  const seller = pick(org.sellers)
  const province = pick(PROVINCES)

  const title = `${pick(catalog.nouns)} ${brand}`.slice(0, 150)
  slugCounter += 1

  const createdAt = faker.date.between({
    from: new Date(NOW - HISTORY_DAYS * DAY_MS),
    to: new Date(NOW - 5 * 60 * 1000),
  })

  const listing: ListingSeed = {
    organizationId: org.id,
    title,
    // Hậu tố là bộ đếm toàn cục chứ không phải chuỗi ngẫu nhiên: unique index
    // (organizationId, slug) không được phép va, mà 1000 chuỗi random 6 ký tự vẫn có xác suất
    // trùng đủ lớn để thỉnh thoảng làm hỏng cả lần seed.
    slug: `${toSlug(title)}-${slugCounter}`,
    description: `${pick(DESC_OPENERS)} ${title.toLowerCase()}. Tình trạng ${
      condition === LISTING_CONDITION.NEW ? 'mới nguyên hộp' : 'đã qua sử dụng, còn dùng tốt'
    }. ${pick(DESC_CLOSERS)}`,
    price: priceFor(),
    isNegotiable: chance(40),
    condition,
    images: imagesFor(`${org.slug}-${slugCounter}`),
    category: categories.get(categorySlug)!,
    seller: seller._id,
    // Snapshot người đăng, khớp cách `listing.model.ts` cố tình không populate `seller`.
    posterName: seller.name,
    posterContact: seller.phone,
    location: {
      address: `${faker.number.int({ min: 1, max: 300 })} đường ${pick(GIVEN_NAMES)}`,
      province,
      ward: pick(wardPool(province)),
    },
    status,
    viewCount: faker.number.int({ min: 0, max: 4000 }),
    favoriteCount: faker.number.int({ min: 0, max: 250 }),
    attributes: attributesFor(categorySlug, brand),
    expiresAt: expiresAtFor(status),
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  }

  // Vết duyệt chỉ có ở tin đã bị quản trị chạm tới — tin `active`/`pending` phải để trống,
  // đó là cách phân biệt "chưa ai duyệt" với "đã duyệt và cho qua".
  if (status === LISTING_STATUS.REJECTED || status === LISTING_STATUS.HIDDEN) {
    listing.moderation = {
      reason: pick(status === LISTING_STATUS.REJECTED ? REJECT_REASONS : HIDE_REASONS),
      byUserId: org.moderator._id,
      byName: org.moderator.name,
      at: new Date(createdAt.getTime() + DAY_MS),
    }
  }

  // 2% soft-delete rải đều: mọi model đều có hook loại `deletedAt != null`, phải có mẫu thì
  // mới biết hook nào quên (chính là bug `countDocuments` đã từng gặp).
  if (chance(2)) listing.deletedAt = new Date(createdAt.getTime() + 2 * DAY_MS)

  return listing
}

type EdgeContext = { org: SeedOrg; categories: Map<CategorySlug, Types.ObjectId> }

/**
 * Các ca biên mà phân phối ngẫu nhiên không đảm bảo sinh ra được. Tất cả đều gắn vào org
 * `hung-vuong` để QA chỉ cần đăng nhập một tài khoản là thấy đủ.
 *
 * Mỗi case tự sửa trọn vẹn document của nó — không có bước vá thêm nào ở ngoài theo chỉ số
 * mảng, vì chỉ số đó lệch ngay khi ai đó chèn một case mới vào giữa danh sách.
 */
const EDGE_CASES: Array<{ label: string; apply: (doc: ListingSeed, ctx: EdgeContext) => void }> = [
  {
    label: 'giá 0đ → app hiển thị "Miễn phí"',
    apply: (doc) => {
      doc.title = 'Tặng sách giáo khoa lớp 12 đã dùng'
      doc.price = 0
      doc.isNegotiable = false
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'không ảnh → app rơi về gradient theo id',
    apply: (doc) => {
      doc.title = 'Bàn học gỗ cũ, không kịp chụp ảnh'
      doc.images = []
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'đủ 12 ảnh (biên trên của validator)',
    apply: (doc) => {
      doc.title = 'Bộ sưu tập truyện tranh 12 ảnh chi tiết'
      doc.images = Array.from(
        { length: 12 },
        (_, i) => `https://picsum.photos/seed/edge-gallery-${i}/800/600`,
      )
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'tiêu đề dài đúng 150 ký tự (maxlength)',
    apply: (doc) => {
      doc.title = `Thanh lý trọn bộ dụng cụ học tập cuối kỳ ${'gồm nhiều món nhỏ '.repeat(10)}`
        .slice(0, 150)
        .trim()
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'mô tả dài 5000 ký tự (maxlength)',
    apply: (doc) => {
      doc.title = 'Laptop cũ kèm mô tả cực dài'
      doc.description = 'Máy còn chạy tốt, pin trên 80 phần trăm, không lỗi lầm gì. '
        .repeat(120)
        .slice(0, 5000)
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'giá cao nhất 80.000.000đ (biên bộ lọc maxPrice)',
    apply: (doc) => {
      doc.title = 'Đàn piano điện Yamaha còn bảo hành'
      doc.price = 80_000_000
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'lượt xem/lưu rất lớn (kiểm tra format số)',
    apply: (doc) => {
      doc.title = 'Xe đạp thể thao Giant bản giới hạn'
      doc.viewCount = 128_400
      doc.favoriteCount = 9_870
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'vừa đăng 2 phút trước (đầu bảng tin)',
    apply: (doc) => {
      doc.title = 'Tai nghe Sony vừa đăng'
      doc.createdAt = new Date(NOW - 2 * 60 * 1000)
      doc.updatedAt = doc.createdAt
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: `tin cũ ${HISTORY_DAYS} ngày (cuối bảng tin)`,
    apply: (doc) => {
      doc.title = 'Kệ sách mini để lâu chưa bán'
      doc.createdAt = new Date(NOW - HISTORY_DAYS * DAY_MS)
      doc.updatedAt = doc.createdAt
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'không có attributes',
    apply: (doc) => {
      doc.title = 'Bình giữ nhiệt không rõ hãng'
      doc.attributes = {}
      doc.status = LISTING_STATUS.ACTIVE
    },
  },
  {
    label: 'thuộc danh mục đã tắt (isActive: false)',
    apply: (doc, ctx) => {
      doc.title = 'Áo đồng phục cũ size M'
      doc.status = LISTING_STATUS.ACTIVE
      doc.category = ctx.categories.get('dong-phuc-cu')!
    },
  },
  {
    label: 'draft — chỉ người đăng thấy',
    apply: (doc) => {
      doc.title = 'Nháp: máy tính Casio fx-580'
      doc.status = LISTING_STATUS.DRAFT
      doc.expiresAt = undefined
    },
  },
  {
    label: 'pending — chờ bàn duyệt',
    apply: (doc) => {
      doc.title = 'Chờ duyệt: bộ dụng cụ vẽ kỹ thuật'
      doc.status = LISTING_STATUS.PENDING
      doc.moderation = undefined
    },
  },
  {
    label: 'rejected — có lý do từ chối',
    apply: (doc, ctx) => {
      doc.title = 'Bị từ chối: điện thoại không rõ nguồn gốc'
      doc.status = LISTING_STATUS.REJECTED
      doc.moderation = {
        reason: 'Ảnh không rõ sản phẩm, vui lòng chụp lại',
        byUserId: ctx.org.moderator._id,
        byName: ctx.org.moderator.name,
        at: new Date(NOW - DAY_MS),
      }
    },
  },
  {
    label: 'hidden — bị ẩn khỏi bảng tin',
    apply: (doc, ctx) => {
      doc.title = 'Đã ẩn: ghế xoay văn phòng'
      doc.status = LISTING_STATUS.HIDDEN
      doc.moderation = {
        reason: 'Tạm ẩn theo yêu cầu người đăng',
        byUserId: ctx.org.moderator._id,
        byName: ctx.org.moderator.name,
        at: new Date(NOW - 2 * DAY_MS),
      }
    },
  },
  {
    label: 'sold — vẫn public theo PUBLIC_LISTING_STATUSES',
    apply: (doc) => {
      doc.title = 'Đã bán: máy tính bảng Samsung Tab A'
      doc.status = LISTING_STATUS.SOLD
    },
  },
  {
    label: 'expired — expiresAt để TRỐNG, xem ghi chú TTL',
    apply: (doc) => {
      doc.title = 'Hết hạn: vợt cầu lông Yonex'
      doc.status = LISTING_STATUS.EXPIRED
      doc.expiresAt = undefined
    },
  },
  {
    label: 'soft-deleted — không được lọt ra bất kỳ query nào',
    apply: (doc) => {
      doc.title = 'Đã xoá mềm: bàn phím cơ cũ'
      doc.status = LISTING_STATUS.ACTIVE
      doc.deletedAt = new Date(NOW - DAY_MS)
    },
  },
  {
    label: 'ở Hải Phòng (bộ lọc province ít dữ liệu)',
    apply: (doc) => {
      doc.title = 'Trống cajon giao tại Hải Phòng'
      doc.status = LISTING_STATUS.ACTIVE
      doc.location.province = 'Hải Phòng'
      doc.location.ward = wardsOf('Hải Phòng')[0]
    },
  },
  {
    label: 'hàng mới + có thương lượng giá',
    apply: (doc) => {
      doc.title = 'Giày chạy bộ Nike mới nguyên hộp'
      doc.status = LISTING_STATUS.ACTIVE
      doc.condition = LISTING_CONDITION.NEW
      doc.isNegotiable = true
    },
  },
]

// ── MAIN ────────────────────────────────────────────────────────────

async function seedBulk() {
  // Trước cả `connect`: chốt phải chặn từ lúc chưa đụng gì tới DB.
  assertDisposableDb('seed:bulk')

  await mongoose.connect(env.MONGO_URI)
  console.log(`Connected. Seeding ${TOTAL_LISTINGS} listings...`)

  // Toàn bộ seed chạy ngoài request nên không có tenant scope — phải khai báo tường minh.
  await runUnscoped('bulk seed script', async () => {
    // Chat/Report/AuditLog trỏ tới listing và user sắp bị xoá; giữ lại là để cả một tập bản ghi
    // mồ côi mà màn chat và bàn duyệt sẽ đọc phải.
    await Promise.all([
      User.deleteMany({}),
      Listing.deleteMany({}),
      Organization.deleteMany({}),
      Notification.deleteMany({}),
      Membership.deleteMany({}),
      RoleGrant.deleteMany({}),
      OrgUnit.deleteMany({}),
      JoinRequest.deleteMany({}),
      Category.deleteMany({}),
      Conversation.deleteMany({}),
      Message.deleteMany({}),
      Report.deleteMany({}),
      AuditLog.deleteMany({}),
    ])

    const categoryDocs = await Category.insertMany(CATEGORY_SEEDS.map((c) => ({ ...c })))
    const categories = new Map<CategorySlug, Types.ObjectId>(
      categoryDocs.map((doc) => [doc.slug as CategorySlug, doc._id]),
    )

    const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS)

    const built = ORG_SEEDS.map((spec) => buildOrg(spec, passwordHash))

    await User.insertMany(built.flatMap((b) => b.rows))
    await Organization.insertMany(
      built.map((b) => ({
        _id: b.org.id,
        name: b.org.name,
        slug: b.org.slug,
        ownerId: b.org.owner._id,
      })),
    )

    const orgs = built.map((b) => b.org)
    const statuses = weightedPool(STATUS_MIX, TOTAL_LISTINGS)
    const conditions = weightedPool(CONDITION_MIX, TOTAL_LISTINGS)

    // Chia tin theo tỉ trọng org, phần dư dồn cho org cuối để tổng luôn tròn TOTAL_LISTINGS.
    const docs: ListingSeed[] = []
    orgs.forEach((org, orgIndex) => {
      const isLast = orgIndex === orgs.length - 1
      const quota = isLast ? TOTAL_LISTINGS - docs.length : Math.floor(TOTAL_LISTINGS * org.share)
      for (let i = 0; i < quota; i += 1) {
        docs.push(buildListing(org, categories, statuses[docs.length], conditions[docs.length]))
      }
    })

    // Ca biên gắn vào những tin đầu tiên của org đầu tiên (hung-vuong).
    EDGE_CASES.forEach((edge, i) => {
      edge.apply(docs[i], { org: orgs[0], categories })
      docs[i].slug = `${toSlug(docs[i].title)}-edge-${i + 1}`
    })

    // Chèn theo lô để log còn nhúc nhích, thay vì một lệnh 1000 document đứng im tới khi xong.
    //
    // `createdAt`/`updatedAt` phải do seed cấp tường minh (xem `buildListing`): `insertMany`
    // gọi `initializeTimestamps()`, mà hàm đó chỉ điền khi field còn TRỐNG — có sẵn giá trị
    // thì Mongoose không đụng vào. Bỏ trống là cả 1000 tin chung một mốc, bảng tin sắp xếp
    // theo `createdAt` mất trật tự và mọi tin đều hiện "vừa xong".
    const BATCH = 200
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH)
      await Listing.insertMany(batch)
      console.log(`  inserted ${Math.min(i + BATCH, docs.length)}/${docs.length}`)
    }

    await Membership.insertMany(built.flatMap((b) => b.memberships))
    await RoleGrant.insertMany(built.flatMap((b) => b.grants))

    // Master là User + grant scope system, không còn collection riêng.
    const master = await User.create({
      email: 'master@platform.local',
      name: 'Platform Master',
      password: 'platform123',
      emailVerifiedAt: new Date(),
    })
    await RoleGrant.create({
      userId: master._id,
      role: SYSTEM_ROLES.MASTER,
      scopeType: SCOPE_TYPES.SYSTEM,
    })

    report(docs, orgs)
  })

  await mongoose.disconnect()
  process.exit(0)
}

/** Đếm từ mảng thật sự đã ghi, không phải từ bảng tỉ lệ — bảng kia chỉ là ý định. */
function report(docs: ListingSeed[], orgs: SeedOrg[]) {
  const tally = <T extends string>(key: (d: ListingSeed) => T) =>
    docs.reduce<Record<string, number>>((acc, d) => {
      const k = key(d)
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})

  const alive = docs.filter((d) => d.deletedAt === null).length
  const byOrg = orgs.map(
    (o) => `${o.slug}=${docs.filter((d) => d.organizationId.equals(o.id)).length}`,
  )

  console.log('\n── Kết quả ─────────────────────────────')
  console.log(`Listings      : ${docs.length} (${alive} sống, ${docs.length - alive} soft-deleted)`)
  console.log(`Theo org      : ${byOrg.join(', ')}`)
  console.log(`Theo status   : ${JSON.stringify(tally((d) => d.status))}`)
  console.log(`Theo condition: ${JSON.stringify(tally((d) => d.condition))}`)
  console.log(`Theo tỉnh     : ${JSON.stringify(tally((d) => d.location.province))}`)
  console.log(`Giá 0đ        : ${docs.filter((d) => d.price === 0).length}`)
  console.log(`Không ảnh     : ${docs.filter((d) => d.images.length === 0).length}`)
  console.log(`Đủ 12 ảnh     : ${docs.filter((d) => d.images.length === 12).length}`)
  console.log(`Có moderation : ${docs.filter((d) => d.moderation).length}`)
  console.log(`Ca biên       : ${EDGE_CASES.length} tin đầu của org ${orgs[0].slug}`)
  console.log('────────────────────────────────────────')
  console.log(
    `Login: POST /auth/login { orgSlug: "${orgs[0].slug}", email: "owner@${orgs[0].slug}.local", password: "${PASSWORD}" }`,
  )
  console.log(`Mọi tài khoản seed dùng chung mật khẩu "${PASSWORD}".`)
}

seedBulk().catch((err) => {
  console.error(err)
  process.exit(1)
})
