import { SYSTEM_ROLES, SCOPE_TYPES, SystemRole, ScopeType } from '../constants'

/**
 * Tầng policy: hàm THUẦN trên một tập grant đã nạp sẵn — không chạm DB, không biết Express.
 *
 * Đây là chỗ duy nhất trả lời "được hay không". Rải câu trả lời đó vào service/controller là
 * cách chắc chắn nhất để hai chỗ trả lời khác nhau, và là thứ khiến "ẩn nút trên UI" bị nhầm
 * là phân quyền. Thuần nên test được không cần Mongo — xem `tests/unit/policy.test.ts`.
 */
export interface Grant {
  role: SystemRole
  scopeType: ScopeType
  orgId?: string | null
  unitId?: string | null
  categoryId?: string | null
  /** Rỗng hoặc `null` = TOÀN QUỐC. Không phải "không tỉnh nào". */
  provinceCodes?: string[] | null
}

/** Tin ở trục org: `unitId` là nhóm con của người đăng, `null` khi org phẳng. */
export interface OrgTarget {
  orgId: string
  unitId?: string | null
}

/** Tin ở trục danh mục: luôn có đủ cả hai, `province` là snapshot cứng trên bản ghi tin. */
export interface CategoryTarget {
  categoryId: string
  provinceCode: string
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a === b
}

/** `null`/rỗng = toàn quốc, nên nó phủ mọi tỉnh — kể cả tỉnh mới thêm sau này. */
function coversProvince(grant: Grant, provinceCode: string): boolean {
  const codes = grant.provinceCodes
  return !codes || codes.length === 0 || codes.includes(provinceCode)
}

function coversProvinces(outer: Grant, inner: Grant): boolean {
  const outerCodes = outer.provinceCodes
  if (!outerCodes || outerCodes.length === 0) return true
  const innerCodes = inner.provinceCodes
  // Cấp con toàn quốc trong khi mình chỉ có vài tỉnh = cấp quá cấp mình.
  if (!innerCodes || innerCodes.length === 0) return false
  return innerCodes.every((code) => outerCodes.includes(code))
}

export function isMaster(grants: Grant[]): boolean {
  return grants.some((g) => g.role === SYSTEM_ROLES.MASTER && g.scopeType === SCOPE_TYPES.SYSTEM)
}

/**
 * Duyệt tin ở TRỤC ORG.
 *
 * `staff` scope `org_unit` chỉ duyệt được nhóm con của mình: tin không ghi `unitId` (org phẳng
 * hoặc người đăng chưa được gán nhóm) nằm ngoài tầm với của họ, phải đẩy lên manager org —
 * đúng ý "duyệt phân tầng" chứ không phải "staff duyệt mọi thứ trong org".
 */
export function canModerateOrg(grants: Grant[], target: OrgTarget): boolean {
  if (isMaster(grants)) return true

  return grants.some((g) => {
    if (g.role === SYSTEM_ROLES.MASTER) return false
    if (g.scopeType === SCOPE_TYPES.ORG) return sameId(g.orgId, target.orgId)
    if (g.scopeType === SCOPE_TYPES.ORG_UNIT) {
      return sameId(g.orgId, target.orgId) && sameId(g.unitId, target.unitId)
    }
    return false
  })
}

/**
 * Quản trị cấu hình của org (nhóm con, cấp quyền staff, cài đặt). Hẹp hơn `canModerateAnyInOrg`:
 * staff duyệt tin được nhưng không được đổi cấu trúc tổ chức.
 */
export function canAdminOrg(grants: Grant[], orgId: string): boolean {
  if (isMaster(grants)) return true

  return grants.some(
    (g) =>
      g.role === SYSTEM_ROLES.MANAGER && g.scopeType === SCOPE_TYPES.ORG && sameId(g.orgId, orgId),
  )
}

/**
 * Chốt ở TẦNG ROUTE: người này có quyền duyệt *thứ gì đó* trong org này không.
 *
 * Tách khỏi `canModerateOrg` vì hai câu hỏi khác nhau: mở được màn hình bàn duyệt (staff nhóm
 * con mở được, chỉ thấy nhóm mình) khác với duyệt được đúng tin này (phải khớp nhóm). Dùng
 * nhầm hàm ở tầng route sẽ khoá luôn staff nhóm con ra khỏi màn hình của chính họ.
 */
export function canModerateAnyInOrg(grants: Grant[], orgId: string): boolean {
  if (isMaster(grants)) return true

  return grants.some(
    (g) =>
      (g.scopeType === SCOPE_TYPES.ORG || g.scopeType === SCOPE_TYPES.ORG_UNIT) &&
      sameId(g.orgId, orgId),
  )
}

/**
 * Duyệt tin ở TRỤC DANH MỤC. Hai trục không giao nhau: hàm này không bao giờ nhìn tới `orgId`,
 * và `canModerateOrg` không bao giờ nhìn tới `categoryId`.
 */
export function canModerateCategory(grants: Grant[], target: CategoryTarget): boolean {
  if (isMaster(grants)) return true

  return grants.some(
    (g) =>
      g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE &&
      sameId(g.categoryId, target.categoryId) &&
      coversProvince(g, target.provinceCode),
  )
}

/** `outer` (của manager) có phủ trọn `inner` (định cấp cho staff) không. */
function covers(outer: Grant, inner: Grant): boolean {
  if (outer.scopeType === SCOPE_TYPES.ORG) {
    if (inner.scopeType === SCOPE_TYPES.ORG) return sameId(outer.orgId, inner.orgId)
    if (inner.scopeType === SCOPE_TYPES.ORG_UNIT) return sameId(outer.orgId, inner.orgId)
    return false
  }
  if (outer.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE) {
    return (
      inner.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE &&
      sameId(outer.categoryId, inner.categoryId) &&
      coversProvinces(outer, inner)
    )
  }
  return false
}

/**
 * §5.3 — ai cấp được quyền cho ai.
 *
 * Master là người duy nhất cấp được `manager`; nếu master cũng là người duy nhất cấp được
 * `staff` thì 500 org × 30 nhóm con = 15.000 lần cấp quyền đổ vào một người. Vì vậy manager
 * cấp được `staff`, nhưng chỉ TRONG scope của chính mình.
 */
export function canGrant(
  actor: { userId: string; grants: Grant[] },
  target: { userId: string; grant: Grant },
): boolean {
  // Không ai tự nâng quyền cho chính mình — kể cả master, để vết cấp quyền luôn có hai người.
  if (actor.userId === target.userId) return false

  if (isMaster(actor.grants)) return true

  // Chỉ master cấp được master/manager. Manager cấp quá cấp mình là leo thang quyền.
  if (target.grant.role !== SYSTEM_ROLES.STAFF) return false

  return actor.grants.some((g) => g.role === SYSTEM_ROLES.MANAGER && covers(g, target.grant))
}

/** Thu hồi grant: cùng luật với cấp — ai cấp được thì thu hồi được. */
export function canRevoke(
  actor: { userId: string; grants: Grant[] },
  target: { userId: string; grant: Grant },
): boolean {
  return canGrant(actor, target)
}
