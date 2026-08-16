export { httpStatus } from './httpStatus'
export type { HttpStatus } from './httpStatus'

export { VN_PROVINCES, VN_PROVINCE_NAMES } from './vnProvince'
export type { VnProvinceName } from './vnProvince'
export { wardsOf, isWardOfProvince } from './vnWard'

/**
 * THÂN PHẬN trong một org (`memberships.role`) — quan hệ với tổ chức, KHÔNG phải quyền hạn.
 * Một giáo viên là thành viên của trường (thân phận) và có thể có hoặc không quyền duyệt tin
 * (`role_grants`). Gộp hai thứ vào một cột thì không biểu diễn nổi trường hợp đó.
 */
export const MEMBERSHIP_ROLES = {
  OWNER: 'owner',
  MEMBER: 'member',
  ALUMNI: 'alumni',
} as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[keyof typeof MEMBERSHIP_ROLES]

/**
 * KHÔNG có 'pending': đơn đang chờ đã được biểu diễn bằng `join_requests.status`. Hai bảng
 * cùng mô tả một trạng thái là chỗ để chúng lệch nhau.
 */
export const MEMBERSHIP_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[keyof typeof MEMBERSHIP_STATUS]

/**
 * Người này vào org bằng đường nào — quyết định mức tin cậy ban đầu.
 *
 * `request` (verify email + chủ org duyệt tay) là mức THẤP NHẤT: verify email chỉ chứng minh
 * người này kiểm soát hộp thư đó, không chứng minh họ thuộc tổ chức của bạn, mà email tạo hàng
 * loạt gần như miễn phí. Ba đường còn lại để dành cho vòng sau (§7.4).
 */
export const JOINED_VIA = {
  REQUEST: 'request',
  ROSTER: 'roster',
  INVITE: 'invite',
  SSO: 'sso',
} as const
export type JoinedVia = (typeof JOINED_VIA)[keyof typeof JOINED_VIA]

export const JOIN_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUS)[keyof typeof JOIN_REQUEST_STATUS]

/** Vòng đời request tham gia (§7.5) — trần và thời hạn, không để hàng đợi phình vô hạn. */
export const JOIN_REQUEST_LIMITS = {
  /** Không ai xử lý thì tự hết hiệu lực, không nằm mãi trong hàng đợi. */
  EXPIRES_IN_DAYS: 21,
  /** Bị từ chối thì phải chờ, chặn spam gửi lại ngay. */
  REJECT_COOLDOWN_DAYS: 7,
  /** Trần số request đang chờ của một user, trên toàn hệ thống. */
  MAX_PENDING_PER_USER: 3,
} as const

export const TENANT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const
export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS]

/**
 * QUYỀN HẠN hệ thống (`role_grants.role`) — khác hẳn `ORG_ROLES` là THÂN PHẬN trong org.
 * Gộp hai thứ vào một cột thì không biểu diễn nổi "thành viên nhưng không có quyền duyệt".
 *
 * `manager` không phải một quyền: nó là tên chung cho hai quyền khác bản chất (quản lý một
 * tổ chức / quản lý một danh mục), phân biệt bằng `scopeType` chứ không bằng thêm role mới.
 */
export const SYSTEM_ROLES = {
  MASTER: 'master',
  MANAGER: 'manager',
  STAFF: 'staff',
} as const
export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES]

/** Phạm vi của một lần cấp quyền. Role nói cấp bậc, scope nói phạm vi. */
export const SCOPE_TYPES = {
  SYSTEM: 'system',
  ORG: 'org',
  ORG_UNIT: 'org_unit',
  CATEGORY_PROVINCE: 'category_province',
} as const
export type ScopeType = (typeof SCOPE_TYPES)[keyof typeof SCOPE_TYPES]

/**
 * Loại org CHỈ dùng để chọn preset `capabilities` lúc tạo. Logic đọc `capabilities`, không
 * bao giờ đọc `orgType` — `if (orgType === 'school')` rải rác nghĩa là hệ thống chưa được
 * tổng quát hoá, mới chỉ thêm một cột.
 */
export const ORG_TYPES = {
  SCHOOL: 'school',
  COMPANY: 'company',
  COMMUNITY: 'community',
  GENERIC: 'generic',
} as const
export type OrgType = (typeof ORG_TYPES)[keyof typeof ORG_TYPES]

/** Hạng xác minh của org — dùng cho badge và chính sách sau này, không gác luồng đăng tin. */
export const VERIFICATION_TIERS = {
  UNVERIFIED: 'unverified',
  CLAIMED: 'claimed',
  VERIFIED: 'verified',
} as const
export type VerificationTier = (typeof VERIFICATION_TIERS)[keyof typeof VERIFICATION_TIERS]

export interface OrgCapabilities {
  /** Có nhóm con (lớp, phòng ban, team) hay là org phẳng. */
  hasUnits: boolean
  /** Có vòng đời theo năm học (lên lớp, cựu thành viên) — thực tế chỉ trường học. */
  hasAcademicYear: boolean
}

/**
 * `orgType` CHỈ để chọn preset lúc tạo; từ đó trở đi code đọc `capabilities`. Đây là ranh giới
 * giữa "tổng quát hoá thật" và "thêm một cột rồi vẫn `if (orgType === 'school')` khắp nơi".
 */
export const ORG_CAPABILITY_PRESETS: Record<OrgType, OrgCapabilities> = {
  [ORG_TYPES.SCHOOL]: { hasUnits: true, hasAcademicYear: true },
  [ORG_TYPES.COMPANY]: { hasUnits: true, hasAcademicYear: false },
  [ORG_TYPES.COMMUNITY]: { hasUnits: false, hasAcademicYear: false },
  [ORG_TYPES.GENERIC]: { hasUnits: false, hasAcademicYear: false },
}

/**
 * Tin hiển thị ở đâu — và từ v2, đây cũng là KHOÁ ĐỊNH TUYẾN hàng đợi duyệt.
 *
 * Quyết định Q3 chọn "giới hạn hiển thị": tin muốn ra trang công khai phải qua manager danh
 * mục, kể cả khi nó thuộc một org. Vì vậy `orgId` chỉ còn là attribution (badge "đăng bởi
 * trường X"), còn `visibility` mới là thứ quyết định ai duyệt.
 */
export const POST_VISIBILITY = {
  ORG_INTERNAL: 'org_internal',
  PUBLIC: 'public',
} as const
export type PostVisibility = (typeof POST_VISIBILITY)[keyof typeof POST_VISIBILITY]

// Vòng đời tin đăng - tính trước để không phải migrate về sau
export const LISTING_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  /** Chờ duyệt, nhưng người đăng KHÔNG phải thành viên org đích — hàng đợi tách riêng. */
  PENDING_UNVERIFIED: 'pending_unverified',
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

/**
 * Hàng đợi duyệt tin. Mỗi tin thuộc ĐÚNG MỘT hàng đợi — thuật toán định tuyến không có ca nào
 * trả về hai giá trị, và `master` là fallback khi ô (danh mục × tỉnh) chưa có ai phụ trách.
 */
export const MODERATION_QUEUE = {
  ORG_MEMBER: 'org_member',
  ORG_OUTSIDER: 'org_outsider',
  CATEGORY: 'category',
  MASTER: 'master',
} as const
export type ModerationQueue = (typeof MODERATION_QUEUE)[keyof typeof MODERATION_QUEUE]

// Vết kiểm toán của thao tác quản trị. Tên dạng `<đối tượng>.<hành động>` để grep ra nhóm.
export const AUDIT_ACTION = {
  LISTING_APPROVE: 'listing.approve',
  LISTING_REJECT: 'listing.reject',
  LISTING_HIDE: 'listing.hide',
  LISTING_UNHIDE: 'listing.unhide',
  LISTING_REMOVE: 'listing.remove',
  REPORT_RESOLVE: 'report.resolve',
  REPORT_DISMISS: 'report.dismiss',
  LISTING_REASSIGN: 'listing.reassign',
} as const
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION]

/**
 * Trạng thái bàn duyệt thao tác được — `draft` là của người đăng, quản trị không đụng.
 *
 * `pending_unverified` PHẢI có mặt: đó là trạng thái của tin do người ngoài gửi vào tổ chức.
 * Thiếu nó thì hàng đợi `org_outsider` sinh ra tin mà không endpoint nào đọc được — tin nằm
 * trong DB, không ai duyệt, và người gửi thì thấy như rơi vào hư không.
 */
export const MODERATABLE_STATUSES = [
  'pending',
  'pending_unverified',
  'active',
  'rejected',
  'hidden',
] as const

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const
