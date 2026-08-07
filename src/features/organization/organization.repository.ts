import { ClientSession, Types } from 'mongoose'
import { Organization, IOrganization, IOrganizationDocument } from './organization.model'
import { TENANT_STATUS, TenantStatus } from '../../common/constants'

/** Đủ để dựng tenant scope — cố tình không mang name/ownerId để cache nhẹ và không lộ thừa. */
export interface OrgSummary {
  _id: Types.ObjectId
  slug: string
  chainId: Types.ObjectId | null
  status: TenantStatus
}

// resolveTenant chạy trên MỌI request, kể cả GET /listings — không cache thì mỗi request
// tốn 1-2 query chỉ để biết org còn sống và chain gồm những org nào.
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

/** Gọi sau mọi thay đổi status/chainId — nếu không, suspend phải chờ hết TTL mới có hiệu lực. */
export function clearOrganizationCache(): void {
  cache.clear()
}

const ALIVE = { status: TENANT_STATUS.ACTIVE, deletedAt: null }
const SUMMARY_FIELDS = '_id slug chainId status'

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

  /** Org bị suspend bị loại khỏi scope đọc của chain — chain không hồi sinh org đã khoá. */
  activeIdsByChain(chainId: Types.ObjectId): Promise<Types.ObjectId[]> {
    return memo(`chain:${chainId.toString()}`, async () => {
      const rows = await Organization.find({ chainId, ...ALIVE })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>()
        .exec()
      return rows.map((row) => row._id)
    })
  },

  create(data: Partial<IOrganization> & { _id: Types.ObjectId }, session?: ClientSession) {
    clearOrganizationCache()
    return Organization.create([data], { session })
  },

  findById(id: string | Types.ObjectId): Promise<IOrganizationDocument | null> {
    return Organization.findOne({ _id: id, deletedAt: null }).exec()
  },

  listByChain(chainId: Types.ObjectId): Promise<IOrganizationDocument[]> {
    return Organization.find({ chainId, deletedAt: null }).sort({ createdAt: 1 }).exec()
  },

  existsBySlug(slug: string) {
    return Organization.exists({ slug: slug.toLowerCase(), deletedAt: null })
  },

  updateById(id: string | Types.ObjectId, update: Partial<IOrganization>) {
    clearOrganizationCache()
    return Organization.findOneAndUpdate({ _id: id, deletedAt: null }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },
}
