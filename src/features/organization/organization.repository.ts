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

  /** Avatar + cover của mọi org — cho job dọn ảnh mồ côi (`upload.cleanup.service.ts`). */
  async allImageUrls(): Promise<string[]> {
    const rows = await Organization.find().select('avatarUrl coverUrl').lean().exec()
    return rows.flatMap((r) => [r.avatarUrl, r.coverUrl]).filter((u): u is string => !!u)
  },
}
