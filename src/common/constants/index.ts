export { httpStatus } from './httpStatus'
export type { HttpStatus } from './httpStatus'

// Quyền TRONG một organization. Thay hẳn ROLES cũ (user|admin|moderator): giữ song song
// hai từ vựng quyền cho cùng một thứ là cách chắc chắn nhất để phân quyền lệch nhau.
export const ORG_ROLES = {
  OWNER: 'owner',
  MODERATOR: 'moderator',
  MEMBER: 'member',
} as const
export type OrgRole = (typeof ORG_ROLES)[keyof typeof ORG_ROLES]

export const TENANT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const
export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS]

// Bên bán phần mềm — nằm NGOÀI mô hình tenant, không có organizationId.
export const PLATFORM_ADMIN_ROLES = {
  SUPER_ADMIN: 'super_admin',
  SUPPORT: 'support',
} as const
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[keyof typeof PLATFORM_ADMIN_ROLES]

export const NOTIFICATION_SOURCE = {
  ORGANIZATION: 'organization',
  CHAIN: 'chain',
} as const
export type NotificationSource = (typeof NOTIFICATION_SOURCE)[keyof typeof NOTIFICATION_SOURCE]

// Vòng đời tin đăng - tính trước để không phải migrate về sau
export const LISTING_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  ACTIVE: 'active',
  SOLD: 'sold',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  HIDDEN: 'hidden',
} as const
export type ListingStatus = (typeof LISTING_STATUS)[keyof typeof LISTING_STATUS]

// Trạng thái được phép lộ ra API public. draft/pending/rejected/hidden là nội bộ:
// lọt ra ngoài nghĩa là người đọc thấy tin chưa duyệt hoặc đã bị từ chối.
export const PUBLIC_LISTING_STATUSES: ListingStatus[] = [
  LISTING_STATUS.ACTIVE,
  LISTING_STATUS.SOLD,
  LISTING_STATUS.EXPIRED,
]

export const LISTING_CONDITION = {
  NEW: 'new',
  LIKE_NEW: 'like_new',
  USED: 'used',
} as const
export type ListingCondition = (typeof LISTING_CONDITION)[keyof typeof LISTING_CONDITION]

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const
