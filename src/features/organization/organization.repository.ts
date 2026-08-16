import { ClientSession, Types } from 'mongoose'
import {
  Organization,
  OrgSlugAlias,
  IOrganization,
  IOrganizationDocument,
} from './organization.model'
import { TENANT_STATUS, TenantStatus } from '../../common/constants'
import { normalizeOrgSlug } from '../../common/utils/orgSlug'

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

const ALIVE = { status: TENANT_STATUS.ACTIVE, deletedAt: null }
const SUMMARY_FIELDS = '_id slug status'

export const organizationRepository = {
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
    const normalized = normalizeOrgSlug(query)
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    return Organization.find({
      ...ALIVE,
      $or: [
        ...(normalized ? [{ slugNormalized: { $regex: `^${normalized}` } }] : []),
        { name: { $regex: escaped, $options: 'i' } },
      ],
    })
      .sort({ name: 1 })
      .limit(limit)
      .exec()
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
}
