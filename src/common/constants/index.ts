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
  /** Người phụ trách org. Quyền THẬT nằm ở `role_grants`, đây chỉ là thân phận hiển thị. */
  ADMIN: 'admin',
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
  /**
   * Org đã tạo nhưng CHƯA có người phụ trách. Master tạo org trước, trao quyền sau.
   *
   * Không phải `ACTIVE` nên `findActiveById` không thấy nó — nghĩa là không ai vào được, đơn
   * gia nhập không gửi được, tin không đăng được. Đúng ý: một org không có ai duyệt thì mọi
   * thứ đổ vào đó chỉ để mục.
   */
  PENDING_ADMIN: 'pending_admin',
} as const
export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS]

/**
 * Tên hiển thị THAY CHO tên thật của master ở mọi chỗ người khác đọc được.
 *
 * Master là một danh tính hệ thống, không phải một đồng nghiệp trong tổ chức: moderator
 * một trường không có việc gì phải biết ai đứng sau lượt duyệt đến từ cấp hệ thống.
 *
 * Ghi vào SNAPSHOT lúc tạo (`audit_logs.actorName`, `reports.reporterName`), không phải
 * che lúc đọc: che lúc đọc thì tên thật vẫn nằm trong DB và rò ra ở lần đổi code sau.
 */
export const MASTER_DISPLAY_NAME = 'Quản trị hệ thống'

/**
 * Tên người dùng có mạo danh nhãn hệ thống không.
 *
 * Từ lúc `MASTER_DISPLAY_NAME` được ghi vào snapshot của nhật ký duyệt và báo cáo, chuỗi
 * đó MANG THẨM QUYỀN: một moderator đặt tên mình đúng như vậy thì dòng của họ trong nhật
 * ký org không phân biệt được với dòng do cấp hệ thống ghi. Che tên master mà không giữ
 * chỗ cái tên ấy là mở ra đúng cái lỗ mình vừa bịt.
 *
 * So sau khi fold khoảng trắng + hạ chữ thường: "quản  trị   hệ thống" nhìn trên màn hình
 * là một chuỗi giống hệt, chặn đúng-từng-ký-tự thì không chặn được gì.
 */
export function impersonatesMaster(name: string): boolean {
  const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return fold(name) === fold(MASTER_DISPLAY_NAME)
}

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
  /**
   * Ô hẹp hơn một bậc: (danh mục × PHƯỜNG). Tầng dưới của `category_province` — grant cấp tỉnh
   * phủ mọi phường trong tỉnh, phường chưa có ai thì tin rơi lên tỉnh rồi mới tới master.
   */
  CATEGORY_WARD: 'category_ward',
} as const
export type ScopeType = (typeof SCOPE_TYPES)[keyof typeof SCOPE_TYPES]

/**
 * HAI TRỤC DUYỆT — và một tài khoản chỉ được đứng trên MỘT.
 *
 * `canApproveListing` chọn người duyệt theo TRỤC CỦA TIN: `marketplace` về bàn danh mục, hai bậc
 * trong nhóm về bàn của nhóm. Tin vì thế vẫn luôn đi đúng chỗ kể cả khi một người ôm cả hai
 * trục — cái mất đi là sự PHÂN ĐỊNH, không phải đường đi của tin.
 *
 * Vì sao vẫn cấm: người ngồi cả hai bàn thì không còn ai là bên thứ hai. Họ đăng tin trong nhóm
 * mình quản rồi tự duyệt ở bàn nhóm, hoặc đẩy chính tin đó lên sàn rồi tự duyệt ở bàn danh mục —
 * hai cửa vốn dựng ra để kiểm chéo nhau thành một cửa. Thêm nữa, hàng đợi của họ trộn tin của
 * hai thế giới khác nhau, và mọi câu hỏi vận hành ("ai phụ trách ô này") mất một câu trả lời duy nhất.
 *
 * `system` (master) KHÔNG thuộc trục nào: master phủ cả hai theo thiết kế, đó là vai vận hành
 * hệ thống chứ không phải một chân trong bàn duyệt.
 */
export const ORG_AXIS_SCOPES: ScopeType[] = [SCOPE_TYPES.ORG, SCOPE_TYPES.ORG_UNIT]
export const CATEGORY_AXIS_SCOPES: ScopeType[] = [
  SCOPE_TYPES.CATEGORY_PROVINCE,
  SCOPE_TYPES.CATEGORY_WARD,
]

export type GrantAxis = 'org' | 'category'

/** Trục của một phạm vi. `null` = `system`, đứng ngoài cả hai. */
export function axisOf(scope: ScopeType): GrantAxis | null {
  if (ORG_AXIS_SCOPES.includes(scope)) return 'org'
  if (CATEGORY_AXIS_SCOPES.includes(scope)) return 'category'
  return null
}

export const AXIS_LABEL: Record<GrantAxis, string> = {
  org: 'quản trị nhóm',
  category: 'phụ trách danh mục',
}

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
 * Bảng tin của một nhóm bày theo kiểu nào.
 *
 * `feed` — mỗi tin một dòng, đọc được cả mô tả và ảnh lớn mà không phải mở ra. Hợp với nhóm
 *   ít tin, nơi mỗi tin đáng dừng lại đọc.
 * `grid` — hai tin một dòng, chỉ ảnh + tên + giá. Hợp với nhóm nhiều tin, nơi người ta lướt
 *   tìm bằng mắt chứ không đọc.
 *
 * Đây là lựa chọn của QUẢN TRỊ NHÓM, không phải của từng người xem: bảng tin là không gian
 * chung của trường, và người dựng nó biết nhóm mình đang ở dạng nào.
 */
export const FEED_LAYOUTS = {
  FEED: 'feed',
  GRID: 'grid',
} as const
export type FeedLayout = (typeof FEED_LAYOUTS)[keyof typeof FEED_LAYOUTS]

/**
 * THANG PHỦ SÓNG của một tin — bậc trên bao bậc dưới.
 *
 * ```
 * members  ⊂  group_open  ⊂  marketplace
 * ```
 *
 * | bậc           | ai đọc được    | ở đâu                            | ai duyệt        |
 * |---------------|----------------|----------------------------------|-----------------|
 * | `members`     | thành viên nhóm| bảng tin nhóm                    | quản trị nhóm   |
 * | `group_open`  | bất kỳ ai      | hồ sơ nhóm + kết quả tìm kiếm    | quản trị nhóm   |
 * | `marketplace` | bất kỳ ai      | thêm bảng tin chung của cả sàn   | manager danh mục|
 *
 * Thay cho `POST_VISIBILITY` hai giá trị, và đảo quyết định Q3 (xem
 * `docs/architecture/v2-org-permission.plan.md`). Hai thứ Q3 không diễn đạt được:
 *
 * 1. Nhóm CÔNG KHAI mà tin bên trong vẫn kín với người ngoài — `group_open` là bậc đó.
 * 2. Muốn bán cho cả nhóm lẫn cả sàn thì phải đăng hai tin rời nhau. Nay tin ở `marketplace`
 *    VẪN nằm trong bảng tin nhóm, nên chỉ có MỘT bản ghi: lượt xem, người quan tâm và hội
 *    thoại không bị tách đôi.
 *
 * Tên `reach` chứ không giữ `visibility`: chữ "visibility" đã bị `Organization.isPublic` và
 * `PATCH /organizations/:id/visibility` chiếm, mà luật hạ bậc (nhóm chuyển riêng tư ⇒ hạ
 * `group_open` về `members`) làm hai thứ đó dính vào nhau. Hai khái niệm coupled cùng tên là
 * cách chắc chắn để quên mất cascade.
 */
export const LISTING_REACH = {
  MEMBERS: 'members',
  GROUP_OPEN: 'group_open',
  MARKETPLACE: 'marketplace',
} as const
export type ListingReach = (typeof LISTING_REACH)[keyof typeof LISTING_REACH]

/**
 * Giới tính trên hồ sơ. `UNDISCLOSED` là MẶC ĐỊNH và là một lựa chọn thật, không phải "chưa
 * điền": người dùng có quyền không nêu, và cột này không được phép ép ai phải chọn.
 */
export const GENDER = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
  UNDISCLOSED: 'undisclosed',
} as const
export type Gender = (typeof GENDER)[keyof typeof GENDER]

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

/**
 * Bậc phủ sóng mà NGƯỜI LẠ đọc được. Đặt ngay cạnh `PUBLIC_LISTING_STATUSES` là có chủ ý: hai
 * mảng này cùng nhau là câu trả lời ĐẦY ĐỦ cho "một người không quan hệ gì với nhóm thấy được
 * gì", và tách chúng ra hai đầu file là cách để sửa một cái mà quên cái kia.
 *
 * `members` vắng mặt, và đó là toàn bộ nội dung của bậc đó.
 */
export const PUBLICLY_READABLE_REACHES: ListingReach[] = [
  LISTING_REACH.GROUP_OPEN,
  LISTING_REACH.MARKETPLACE,
]

export const LISTING_CONDITION = {
  NEW: 'new',
  LIKE_NEW: 'like_new',
  USED: 'used',
} as const
export type ListingCondition = (typeof LISTING_CONDITION)[keyof typeof LISTING_CONDITION]

/**
 * Kiểu của một field trong template tin đăng — quyết định cả component FE lẫn phép ép kiểu
 * ở `validateAttributes`. Danh sách ĐÓNG: mỗi giá trị mới ở đây là một component RN phải
 * viết thêm, nên thêm giá trị là một quyết định thiết kế chứ không phải một dòng config.
 */
export const FIELD_TYPE = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  BOOLEAN: 'boolean',
  /** Vẫn lưu `Number`; tách khỏi `number` chỉ để FE dựng dropdown năm thay vì ô nhập tự do. */
  YEAR: 'year',
} as const
export type FieldType = (typeof FIELD_TYPE)[keyof typeof FIELD_TYPE]

/** Kiểu lưu ra `Number` — gom một chỗ để `validateAttributes` không phải liệt kê lại. */
export const NUMERIC_FIELD_TYPES: FieldType[] = [FIELD_TYPE.NUMBER, FIELD_TYPE.YEAR]

/**
 * `draft` chưa ai thấy; `published` là bản đang phục vụ. KHÔNG có `archived`: bản cũ giữ
 * nguyên `published` mãi mãi vì tin đã đăng vẫn đọc nó (đặc tả §Bước 6) — thứ chọn ra bản
 * mới nhất là `version`, không phải trạng thái.
 */
export const TEMPLATE_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
} as const
export type TemplateStatus = (typeof TEMPLATE_STATUS)[keyof typeof TEMPLATE_STATUS]

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

/**
 * Hai HẠNG thao tác của bàn duyệt, và chúng không cùng một thẩm quyền.
 *
 * `APPROVE` — cho tin đi tiếp trên trục của nó. Thẩm quyền theo ĐÚNG trục: tin công khai thuộc
 * người phụ trách danh mục, tin của nhóm thuộc quản trị nhóm.
 *
 * `TAKEDOWN` — rút tin khỏi lưu thông. Cửa này RỘNG hơn: nhóm sở hữu tin luôn gỡ được tin mang
 * tên mình, kể cả tin đã lên bảng tin chung. Đó là quyền *từ chối cho mượn tên*, khác hẳn quyền
 * *duyệt cho lên bảng chung* — nhóm không đẩy tin lên sàn được, nhưng phải rút được tin đang
 * đứng dưới tên họ.
 */
export const MODERATION_ACTION = {
  APPROVE: 'approve',
  TAKEDOWN: 'takedown',
} as const
export type ModerationAction = (typeof MODERATION_ACTION)[keyof typeof MODERATION_ACTION]

/**
 * Quyết định nào thuộc hạng nào — BẢNG DUY NHẤT cho cả hai lớp chốt (`moderation.service` ở
 * ngoài, `listing.service.setModerationStatus` ở trong). Hai lớp cùng tra một bảng thì không có
 * cách nào lệch nhau; mỗi bên tự phán một kiểu là lớp ngoài cho qua còn lớp trong chặn, hoặc tệ
 * hơn là ngược lại.
 *
 * `rejected` nằm ở `APPROVE` chứ không phải `TAKEDOWN`: từ chối là một PHÁN QUYẾT có hệ quả lên
 * uy tín người bán, còn ẩn thì không (`applyTrustEffect`). Nhóm rút được tin khỏi lưu thông,
 * nhưng không ghi được án lên hồ sơ người bán ở một trục không phải của họ.
 */
export const ACTION_BY_DECISION = {
  [LISTING_STATUS.ACTIVE]: MODERATION_ACTION.APPROVE,
  [LISTING_STATUS.REJECTED]: MODERATION_ACTION.APPROVE,
  [LISTING_STATUS.HIDDEN]: MODERATION_ACTION.TAKEDOWN,
} as const
export type ModerationDecision = keyof typeof ACTION_BY_DECISION

/**
 * Trạng thái TRƯỚC mà mỗi quyết định của bàn duyệt được phép đứng lên — máy trạng thái của
 * `setModerationStatus`. Cùng-trạng-thái không nằm trong bảng: lớp ngoài coi là no-op (không
 * uy tín, không báo, không nhật ký), vì bấm "duyệt" lần hai lên tin đang active từng cộng thêm
 * một bài sạch mỗi lần bấm.
 *
 * `sold`/`expired` KHÔNG nhận `active`: hồi sinh tin đã bán là việc chủ tin đăng tin mới, còn
 * tin hết hạn là `renew` của chính chủ — bàn duyệt không có việc gì với hai trạng thái đó ngoài
 * ẩn. `rejected` không nhận `hidden`: tin đã bị từ chối không ở trên bảng để mà ẩn.
 */
export const MODERATION_TRANSITIONS: Record<ModerationDecision, readonly ListingStatus[]> = {
  [LISTING_STATUS.ACTIVE]: [
    LISTING_STATUS.PENDING,
    LISTING_STATUS.PENDING_UNVERIFIED,
    LISTING_STATUS.HIDDEN,
    LISTING_STATUS.REJECTED,
  ],
  [LISTING_STATUS.REJECTED]: [
    LISTING_STATUS.PENDING,
    LISTING_STATUS.PENDING_UNVERIFIED,
    LISTING_STATUS.ACTIVE,
    LISTING_STATUS.HIDDEN,
  ],
  [LISTING_STATUS.HIDDEN]: [
    LISTING_STATUS.PENDING,
    LISTING_STATUS.PENDING_UNVERIFIED,
    LISTING_STATUS.ACTIVE,
    LISTING_STATUS.SOLD,
    LISTING_STATUS.EXPIRED,
  ],
}

/**
 * Cách một báo cáo bị đóng KHÔNG do người duyệt bấm: đối tượng bị xoá/gỡ/ẩn hàng loạt trước khi
 * ai kịp xử. Ghi vào `resolution.action` để phân biệt với `hide_target`/`ignore` của người thật.
 */
export const REPORT_AUTO_RESOLUTION = {
  TARGET_REMOVED: 'target_removed',
} as const

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
 * Mức độ của một lượt TỪ CHỐI. Trước đây ảnh mờ và bán hàng cấm trừ đúng một bậc như nhau —
 * người bán thật thà bị đối xử như kẻ gian.
 *
 * `quality`  — tin sai sót, sửa rồi đăng lại: KHÔNG đụng uy tín, KHÔNG bóp hạn mức.
 * `violation` — vi phạm quy định sàn: tụt bậc + vào cửa sổ phạt 7 ngày.
 *
 * Mặc định là `quality`: người duyệt phải CHỦ ĐỘNG nói "đây là vi phạm" mới có hình phạt.
 * Ngược lại thì mọi cú bấm từ chối đều trừng phạt, đúng cái bất công vừa sửa.
 */
export const REJECTION_SEVERITIES = ['quality', 'violation'] as const
export type RejectionSeverity = (typeof REJECTION_SEVERITIES)[number]

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

/**
 * Múi giờ gộp nhóm của MỌI báo cáo theo thời gian.
 *
 * Gộp theo UTC là sai với sàn này: người Việt đăng tin nhiều nhất vào buổi tối, mà 21h giờ VN
 * là 14h UTC cùng ngày — còn tin đăng lúc 0h–7h sáng lại rơi về NGÀY HÔM TRƯỚC của UTC. Biểu
 * đồ vì thế lệch một phần đáng kể mỗi ngày, và không ai nhìn ra vì nó vẫn "trông hợp lý".
 *
 * Một hằng số cứng chứ không phải env: đây là múi giờ của THỊ TRƯỜNG (34 tỉnh Việt Nam), không
 * phải của máy chủ hay của người xem. Đổi nó là đổi định nghĩa "một ngày" trong mọi báo cáo.
 * Mongo nhận tên IANA trực tiếp trong `$dateToString`.
 */
export const REPORT_TIMEZONE = 'Asia/Ho_Chi_Minh'

export const REPORT_GRANULARITY = {
  DAY: 'day',
  MONTH: 'month',
  YEAR: 'year',
} as const
export type ReportGranularity = (typeof REPORT_GRANULARITY)[keyof typeof REPORT_GRANULARITY]

/**
 * Cửa sổ mặc định và TRẦN SỐ CỘT cho từng độ mịn.
 *
 * Trần là chốt an toàn, không phải tuỳ chọn: một yêu cầu `day` trải 10 năm là 3650 cột — vô
 * dụng trên màn hình, mà vẫn bắt Mongo quét trọn bảng và bắt client nuốt một mảng khổng lồ.
 * Vượt trần thì CẮT BỚT phần cũ nhất và nói ra trong `meta`, không im lặng trả một nửa.
 */
export const REPORT_WINDOW = {
  [REPORT_GRANULARITY.DAY]: { defaultBuckets: 30, maxBuckets: 366 },
  [REPORT_GRANULARITY.MONTH]: { defaultBuckets: 12, maxBuckets: 60 },
  [REPORT_GRANULARITY.YEAR]: { defaultBuckets: 5, maxBuckets: 20 },
} as const

/**
 * Mỗi trang TỐI ĐA 10 dòng, và client không xin hơn được: mọi schema `limit` khai
 * `.max(PAGINATION.MAX_LIMIT)` — xin 11 là 400, không phải bị kẹp âm thầm. Con số nhỏ có chủ ý:
 * app tải-tới-đâu-cuộn-tới-đó, một trang chỉ cần đủ lấp màn hình; trang 50–100 dòng như trước là
 * trả cả kho cho một màn chỉ vẽ được 6 dòng đầu, và phần còn lại là băng thông lẫn decode ảnh
 * ném đi. Từ điển bounded (danh mục, tỉnh/xã, cụm cấm…) không đi qua đây — chúng trả đủ.
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 10,
} as const

export const INVITE_CHANNELS = { EMAIL: 'email', PHONE: 'phone' } as const
export type InviteChannel = (typeof INVITE_CHANNELS)[keyof typeof INVITE_CHANNELS]

export const INVITE_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const
export type InviteStatus = (typeof INVITE_STATUS)[keyof typeof INVITE_STATUS]

/** Lời mời sống 14 ngày: đủ để người ta thấy tin nhắn, ngắn để một link rò rỉ không sống mãi. */
export const INVITE_TTL_DAYS = 14

/**
 * Trạng thái của một đánh giá do tổ chức xã hội gửi lên (cụm TẠM THỜI — xem
 * `features/social-feedback/social-feedback.model.ts`).
 *
 * `pending` là mặc định vì cửa gửi KHÔNG đăng nhập: bất kỳ ai cũng POST được, nên không có
 * bước duyệt thì trang công bố pháp lý thành bảng tin của người qua đường.
 */
export const SOCIAL_FEEDBACK_STATUS = {
  PENDING: 'pending',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
} as const
export type SocialFeedbackStatus =
  (typeof SOCIAL_FEEDBACK_STATUS)[keyof typeof SOCIAL_FEEDBACK_STATUS]
