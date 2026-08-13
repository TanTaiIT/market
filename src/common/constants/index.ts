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

// Người dùng báo cáo tin hoặc người khác. Danh sách đóng để bàn quản trị lọc và thống kê được
// — để người dùng gõ tự do thì không nhóm nổi.
export const REPORT_KIND = {
  SCAM: 'scam',
  WRONG_INFO: 'wrong_info',
  HARASSMENT: 'harassment',
  BANNED_ITEM: 'banned_item',
  OTHER: 'other',
} as const
export type ReportKind = (typeof REPORT_KIND)[keyof typeof REPORT_KIND]

export const REPORT_TARGET = { LISTING: 'listing', USER: 'user' } as const
export type ReportTarget = (typeof REPORT_TARGET)[keyof typeof REPORT_TARGET]

export const REPORT_STATUS = {
  OPEN: 'open',
  /** Đã xử: gỡ/ẩn đối tượng bị báo cáo. */
  RESOLVED: 'resolved',
  /** Đã xem và kết luận báo cáo không đúng. */
  DISMISSED: 'dismissed',
} as const
export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS]

// Vết kiểm toán của thao tác quản trị. Tên dạng `<đối tượng>.<hành động>` để grep ra nhóm.
export const AUDIT_ACTION = {
  LISTING_APPROVE: 'listing.approve',
  LISTING_REJECT: 'listing.reject',
  LISTING_HIDE: 'listing.hide',
  LISTING_UNHIDE: 'listing.unhide',
  LISTING_REMOVE: 'listing.remove',
  REPORT_RESOLVE: 'report.resolve',
  REPORT_DISMISS: 'report.dismiss',
} as const
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION]

/** Trạng thái bàn duyệt thao tác được — `draft` là của người đăng, quản trị không đụng. */
export const MODERATABLE_STATUSES = ['pending', 'active', 'rejected', 'hidden'] as const

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const
