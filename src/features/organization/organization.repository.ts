import { ClientSession, FilterQuery, Types } from 'mongoose'
import {
  Organization,
  OrgSlugAlias,
  IOrganization,
  IOrganizationDocument,
} from './organization.model'
import { TENANT_STATUS, TenantStatus } from '../../common/constants'
import { normalizeOrgSlug, orgNameTokens } from '../../common/utils/orgSlug'

/** Đủ để dựng tenant scope — cố tình không mang name/ownerId để cache nhẹ và không lộ thừa. */
export interface OrgSummary {
  _id: Types.ObjectId
  slug: string
  status: TenantStatus
}

// resolveTenant chạy trên MỌI request, kể cả GET /listings — không cache thì mỗi request
// tốn một query chỉ để biết org còn sống.
// ponytail: in-memory nên stale tối đa TTL và không dùng chung giữa các instance;
// chuyển sang Redis khi chạy nhiều instance hoặc cần suspend có hiệu lực tức thì.
const CACHE_TTL_MS = 30_000
const cache = new Map<string, { value: unknown; expiresAt: number }>()

async function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value as T

  const value = await load()
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

/** Gọi sau mọi thay đổi status — nếu không, suspend phải chờ hết TTL mới có hiệu lực. */
export function clearOrganizationCache(): void {
  cache.clear()
}

/**
 * Hai nhánh tìm theo tên, dùng chung cho dropdown công khai và bảng quản trị.
 *
 * Cả hai đều là regex NEO ĐẦU trên một field CÓ index, nên mỗi nhánh có bounds thật. Bản cũ
 * dùng `{ name: { $regex: <người dùng gõ>, $options: 'i' } }`: không neo đầu, `name` không có
 * index, và trong `$or` thì một nhánh không index kéo cả câu về COLLSCAN.
 *
 * Không phải escape regex: `normalizeOrgSlug`/`orgNameTokens` đã slugify nên chuỗi chỉ còn
 * a-z0-9 — ký tự đặc biệt bị loại từ trước, không phải chặn ở đây.
 *
 * Rỗng (hoặc toàn ký tự lạ) → mảng rỗng, và người gọi phải BỎ HẲN `$or` chứ không truyền
 * `$or: []` — Mongo coi đó là lỗi cú pháp.
 */
function nameBranches(query: string): FilterQuery<IOrganizationDocument>[] {
  const normalized = normalizeOrgSlug(query)
  const tokens = orgNameTokens(query)

  const branches: FilterQuery<IOrganizationDocument>[] = []
  if (normalized) branches.push({ slugNormalized: { $regex: `^${normalized}` } })
  // `$and` chứ không phải một điều kiện: gõ "hung vuong" phải khớp org có CẢ HAI từ, chứ
  // không phải mọi org có một trong hai.
  if (tokens.length > 0) {
    branches.push({ $and: tokens.map((token) => ({ nameTokens: { $regex: `^${token}` } })) })
  }
  return branches
}

/*
 * `$ne: false` chứ KHÔNG phải `true`: org tạo trước khi `isPublic` ra đời không có field đó,
 * mà `default: true` của mongoose chỉ áp cho document MỚI — filter thì chạy dưới MongoDB nên
 * `{ isPublic: true }` trượt sạch dữ liệu cũ. Thiếu field = công khai, đúng nghĩa cái default.
 */
const PUBLIC = { isPublic: { $ne: false } }
const ALIVE = { status: TENANT_STATUS.ACTIVE, deletedAt: null }
const SUMMARY_FIELDS = '_id slug status'

export const organizationRepository = {
  /** Tra theo mã nhóm. Chỉ org đang hoạt động — org bị khoá thì mã cũng ngừng dùng được. */
  findActiveByJoinCode(joinCode: string) {
    return Organization.findOne({ joinCode, ...ALIVE }).exec()
  },

  findActiveById(id: string | Types.ObjectId): Promise<OrgSummary | null> {
    return memo(`id:${id.toString()}`, () =>
      Organization.findOne({ _id: id, ...ALIVE })
        .select(SUMMARY_FIELDS)
        .lean<OrgSummary | null>()
        .exec(),
    )
  },

  findActiveBySlug(slug: string): Promise<OrgSummary | null> {
    return memo(`slug:${slug.toLowerCase()}`, () =>
      Organization.findOne({ slug: slug.toLowerCase(), ...ALIVE })
        .select(SUMMARY_FIELDS)
        .lean<OrgSummary | null>()
        .exec(),
    )
  },

  create(data: Partial<IOrganization> & { _id: Types.ObjectId }, session?: ClientSession) {
    clearOrganizationCache()
    return Organization.create([data], { session })
  },

  /**
   * Nhiều org trong MỘT lượt — đầu vào của mọi chỗ phải ghép org vào một danh sách.
   *
   * Không đi qua `memo` như `findActiveById`: cache đó theo từng id, gọi lô sẽ vừa trượt
   * cache vừa phải ghép lại — mà một `$in` trên `_id` thì đã là truy vấn rẻ nhất có thể.
   *
   * Giữ nguyên `deletedAt: null` chứ không lọc `ACTIVE`: người gọi cần phân biệt "org bị
   * khoá" với "org không còn", và bản thân danh sách trả về đã cho họ làm việc đó.
   */
  findByIds(ids: Types.ObjectId[]): Promise<IOrganizationDocument[]> {
    if (ids.length === 0) return Promise.resolve([])
    return Organization.find({ _id: { $in: ids }, deletedAt: null }).exec()
  },

  findById(id: string | Types.ObjectId): Promise<IOrganizationDocument | null> {
    return Organization.findOne({ _id: id, deletedAt: null }).exec()
  },

  existsBySlug(slug: string) {
    return Organization.exists({ slug: slug.toLowerCase(), deletedAt: null })
  },

  /** Chặn cả biến thể nhìn giống nhau, không chỉ trùng khít. */
  existsBySlugNormalized(slug: string) {
    return Organization.exists({ slugNormalized: normalizeOrgSlug(slug), deletedAt: null })
  },

  /**
   * Dropdown chọn org. Tìm theo `slugNormalized` (đã fold dấu nên gõ không dấu vẫn ra) HOẶC
   * theo tên. Trả về đủ tỉnh/quận để người dùng phân biệt hai org trùng tên — thiếu nó thì
   * dropdown chỉ là một danh sách "Lý Thường Kiệt" giống hệt nhau (§6.2).
   */
  search(query: string, limit: number): Promise<IOrganizationDocument[]> {
    const branches = nameBranches(query)
    return Organization.find(branches.length > 0 ? { ...ALIVE, $or: branches } : ALIVE)
      .sort({ name: 1 })
      .limit(limit)
      .exec()
  },

  /**
   * Nhóm CÔNG KHAI khớp từ khoá — nguồn của kết quả tìm và khối gợi ý.
   *
   * `isPublic: true` là chốt duy nhất tách hai chế độ: nhóm riêng tư không bao giờ lọt vào bất
   * kỳ danh sách nào, chỉ vào được bằng mã. Đặt ở repository chứ không ở service để mọi đường
   * đọc công khai đều đi qua cùng một điều kiện.
   *
   * Từ khoá rỗng = trả nhóm đầu danh sách, đúng nhu cầu "Gợi ý cho bạn" lúc chưa gõ gì.
   */
  searchPublic(query: string, limit: number): Promise<IOrganizationDocument[]> {
    const branches = nameBranches(query)
    const base = { ...ALIVE, ...PUBLIC }
    return Organization.find(branches.length > 0 ? { ...base, $or: branches } : base)
      .sort({ name: 1 })
      .limit(limit)
      .exec()
  },

  /**
   * Nhóm CÔNG KHAI theo slug. Nhóm riêng tư trả `null` — dùng cho đường xin vào, nơi người
   * gọi chưa có quan hệ nào với nhóm.
   */
  findPublicBySlug(slug: string): Promise<IOrganizationDocument | null> {
    return Organization.findOne({ slug: slug.toLowerCase(), ...PUBLIC, ...ALIVE }).exec()
  },

  /**
   * Nhóm theo slug, KHÔNG lọc riêng tư — người gọi tự quyết định ai được xem.
   *
   * Tồn tại vì thành viên của một nhóm kín vẫn phải mở được hồ sơ nhóm mình: lọc `isPublic`
   * ngay ở đây thì chính quản trị nhóm cũng nhận 404 trên nhóm họ đang quản.
   */
  findAliveBySlug(slug: string): Promise<IOrganizationDocument | null> {
    return Organization.findOne({ slug: slug.toLowerCase(), ...ALIVE }).exec()
  },

  /**
   * Bảng tổ chức của master. Cố tình KHÔNG lọc `ALIVE`: org đang bị khoá chính là thứ master
   * cần nhìn thấy để xử lý, giấu nó đi thì bảng quản trị mất đúng phần việc của nó. Chỉ org
   * đã xoá mềm mới bị loại.
   */
  async paginateAll(
    filters: { q?: string; status?: TenantStatus },
    { skip, limit }: { skip: number; limit: number },
  ) {
    const filter: FilterQuery<IOrganizationDocument> = { deletedAt: null }
    if (filters.status) filter.status = filters.status

    const branches = filters.q ? nameBranches(filters.q) : []
    if (branches.length > 0) filter.$or = branches

    const [items, total] = await Promise.all([
      Organization.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      Organization.countDocuments(filter).exec(),
    ])
    return { items, total }
  },

  /**
   * Id của mọi org đang hoạt động — tập `readableOrgIds` cho master đọc xuyên tổ chức.
   *
   * Chỉ `ACTIVE`: org bị khoá hay chưa có người phụ trách thì nội dung bên trong cũng ngừng
   * lưu thông, gộp vào đây là master duyệt tin cho một tổ chức đang đóng cửa.
   */
  allActiveIds(): Promise<Types.ObjectId[]> {
    return Organization.distinct('_id', ALIVE).exec()
  },

  findAliasTarget(slug: string): Promise<Types.ObjectId | null> {
    return OrgSlugAlias.findOne({ oldSlug: slug.toLowerCase() })
      .lean<{ organizationId: Types.ObjectId } | null>()
      .exec()
      .then((row) => row?.organizationId ?? null)
  },

  createAlias(oldSlug: string, organizationId: Types.ObjectId) {
    return OrgSlugAlias.create({ oldSlug: oldSlug.toLowerCase(), organizationId })
  },

  updateById(id: string | Types.ObjectId, update: Partial<IOrganization>) {
    clearOrganizationCache()
    return Organization.findOneAndUpdate({ _id: id, deletedAt: null }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },

  /**
   * Xoá avatar/cover bị máy kiểm ảnh từ chối (webhook `moderation.webhook.service.ts`).
   * Hai lệnh rời vì mỗi field cần điều kiện khớp riêng; cache hồ sơ org phải xả như mọi update.
   */
  async clearImageRefs(pattern: RegExp): Promise<number> {
    const [avatars, covers] = await Promise.all([
      Organization.updateMany({ avatarUrl: pattern }, { avatarUrl: '' }).exec(),
      Organization.updateMany({ coverUrl: pattern }, { coverUrl: '' }).exec(),
    ])
    const modified = avatars.modifiedCount + covers.modifiedCount
    if (modified > 0) clearOrganizationCache()
    return modified
  },

  /** Avatar + cover của mọi org — cho job dọn ảnh mồ côi (`upload.cleanup.service.ts`). */
  async allImageUrls(): Promise<string[]> {
    const rows = await Organization.find().select('avatarUrl coverUrl').lean().exec()
    return rows.flatMap((r) => [r.avatarUrl, r.coverUrl]).filter((u): u is string => !!u)
  },
}
