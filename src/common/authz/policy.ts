import {
  LISTING_REACH,
  SYSTEM_ROLES,
  SCOPE_TYPES,
  ListingReach,
  SystemRole,
  ScopeType,
} from '../constants'

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
  /** Phường/xã của scope `category_ward`; đi kèm ĐÚNG một tỉnh trong `provinceCodes`. */
  wardCodes?: string[] | null
}

/** Tin ở trục org: `unitId` là nhóm con của người đăng, `null` khi org phẳng. */
export interface OrgTarget {
  orgId: string
  unitId?: string | null
}

/**
 * Ô của một tin ở trục danh mục — `province`/`ward` là snapshot cứng trên bản ghi tin.
 * `wardCode: null` = tin công khai CŨ trước migration ward-axis, chỉ tầng tỉnh đỡ được.
 */
export interface CategoryTarget {
  categoryId: string
  provinceCode: string
  wardCode: string | null
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a === b
}

/** `null`/rỗng = toàn quốc, nên nó phủ mọi tỉnh — kể cả tỉnh mới thêm sau này. */
function coversProvince(grant: Grant, provinceCode: string): boolean {
  const codes = grant.provinceCodes
  return !codes || codes.length === 0 || codes.includes(provinceCode)
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
 * Duyệt tin ở TRỤC DANH MỤC — hai tầng, tỉnh phủ trên phường.
 *
 * Hai trục không giao nhau: hàm này không bao giờ nhìn tới `orgId`, và `canModerateOrg` không
 * bao giờ nhìn tới `categoryId`. Trong trục này thì grant cấp tỉnh phủ MỌI phường của tỉnh đó
 * (kể cả phường tách ra sau này) — nhờ vậy ô phường chưa có ai vẫn có người đỡ trước khi rơi
 * xuống master, thay vì 3.321 phường × N danh mục đổ hết về một người.
 */
export function canModerateCategory(grants: Grant[], target: CategoryTarget): boolean {
  if (isMaster(grants)) return true

  return grants.some((g) => {
    if (!sameId(g.categoryId, target.categoryId)) return false

    if (g.scopeType === SCOPE_TYPES.CATEGORY_PROVINCE) {
      return coversProvince(g, target.provinceCode)
    }
    if (g.scopeType === SCOPE_TYPES.CATEGORY_WARD) {
      return (
        target.wardCode !== null &&
        (g.provinceCodes ?? []).includes(target.provinceCode) &&
        (g.wardCodes ?? []).includes(target.wardCode)
      )
    }
    return false
  })
}

/**
 * Tin ở dạng policy đọc được. Cố tình KHÔNG phải `IListingDocument`: policy là tầng dưới cùng,
 * kéo model của một feature vào đây là mở đường cho nó phụ thuộc ngược lên tầng trên.
 */
export interface ListingTarget {
  reach: ListingReach
  organizationId: string | null
  unitId: string | null
  categoryId: string
  provinceCode: string | null
  wardCode: string | null
}

/**
 * DUYỆT được đúng tin này không — TRỤC CỦA TIN chọn người có thẩm quyền, không phải vai của
 * người đang hỏi. Gộp hai nhánh vào một hàm để không có call-site nào chỉ kiểm một nửa: đó
 * đúng là cách `report.service` từng ẩn được tin trục danh mục bằng quyền của org.
 *
 * Chỉ trả lời câu "cho tin đi tiếp". Câu "rút tin xuống" rộng hơn — xem `canTakedownListing`.
 */
export function canApproveListing(grants: Grant[], listing: ListingTarget): boolean {
  // CHỈ `marketplace` nằm trên bàn danh mục. `group_open` đọc được công khai nhưng vẫn do
  // chính nhóm duyệt — gộp nó vào nhánh này là chuyển quyền duyệt của nhóm cho người lạ.
  if (listing.reach === LISTING_REACH.MARKETPLACE) {
    return canModerateCategory(grants, {
      categoryId: listing.categoryId,
      // `''` không khớp tỉnh nào, nhưng grant toàn quốc (`provinceCodes` rỗng) vẫn phủ được —
      // đúng ý: tin công khai thiếu tỉnh chỉ master và người phụ trách toàn quốc mới đụng.
      provinceCode: listing.provinceCode ?? '',
      wardCode: listing.wardCode,
    })
  }
  return canModerateOrg(grants, {
    orgId: listing.organizationId ?? '',
    unitId: listing.unitId,
  })
}

/**
 * GỠ/ẨN được đúng tin này không — cửa rộng hơn `canApproveListing` đúng một vế.
 *
 * Ai duyệt được thì đương nhiên gỡ được. NGOÀI RA, nhóm sở hữu tin gỡ được tin mang tên mình ở
 * mọi trục — kể cả tin công khai, thứ mà họ không có lấy một lượt duyệt nào. Lý do: tin công
 * khai vẫn đeo badge "đăng bởi nhóm X" trước cả sàn, nên nhóm phải từ chối cho mượn tên được.
 * Trước đây họ NHÌN THẤY tin đó trong hàng đợi của mình (nhánh đọc rộng hơn nhánh ghi) rồi ăn
 * 403 khi chạm vào — thấy mà không đụng được là dạng tệ nhất.
 *
 * Vế thêm chỉ có tác dụng với tin CÔNG KHAI mang org: với tin nội bộ nó trùng khít vế đầu.
 *
 * `canModerateOrg` chứ KHÔNG `canAdminOrg`, và điều đó tự loại staff nhóm con: `routeListing`
 * đặt `unitId: null` cho nhánh công khai, mà `sameId(null, null)` là `false` — nên chỉ grant cấp
 * ORG mới với tới. Đừng "sửa" `sameId` cho nhận `null`, nó sẽ nới chỗ này mà không ai để ý.
 */
export function canTakedownListing(grants: Grant[], listing: ListingTarget): boolean {
  if (canApproveListing(grants, listing)) return true

  return (
    listing.organizationId !== null &&
    canModerateOrg(grants, { orgId: listing.organizationId, unitId: listing.unitId })
  )
}

/**
 * Đẩy tin lên đầu bảng.
 *
 * Theo TRỤC CỦA TIN như `canApproveListing` — tin công khai do người phụ trách danh mục quyết,
 * tin của nhóm do quản trị nhóm quyết — nhưng HẸP HƠN ở vế org: `canModerateOrg` cho cả staff
 * nhóm con, còn đây chỉ `canAdminOrg`.
 *
 * KHÔNG nới theo `canTakedownListing`: gỡ là rút tin của mình xuống, còn đẩy là LẤY CHỖ của tin
 * người khác trên một bảng không thuộc về nhóm. Hai chiều ngược nhau, không đối xứng được.
 *
 * Vì hai việc khác hạng: duyệt tin là nói "tin này hợp lệ", còn đẩy tin là LẤY CHỖ của tin
 * người khác trên bảng. Thứ hai là quyết định phân phối, thuộc người chịu trách nhiệm cả bề
 * mặt đó. Master phủ cả hai nhánh (kiểm bên trong từng hàm).
 */
export function canBumpListing(grants: Grant[], listing: ListingTarget): boolean {
  if (listing.reach === LISTING_REACH.MARKETPLACE) {
    return canModerateCategory(grants, {
      categoryId: listing.categoryId,
      provinceCode: listing.provinceCode ?? '',
      wardCode: listing.wardCode,
    })
  }
  return canAdminOrg(grants, listing.organizationId ?? '')
}

/**
 * §5.3 — ai cấp được quyền cho ai: CHỈ master.
 *
 * Hệ thống không còn "cấp phó": quản trị nhóm không cấp được quyền cho ai, và vai trò `staff`
 * không còn cấp mới được (`createRoleGrantSchema` từ chối từ cửa). Bản trước cho manager cấp
 * `staff` trong scope của mình để chia tải — đổi lại là một tầng quyền thứ ba mà không ai
 * kiểm soát được từ trung tâm; giờ mỗi nhóm có đúng những quản trị master đã đặt, không hơn.
 * Grant `staff` còn trong DB vẫn được policy duyệt-tin hiểu (di sản), nhưng không sinh thêm.
 *
 * Role `master` thì KHÔNG AI cấp được, kể cả master. Hệ thống có đúng MỘT master và nó là dữ
 * liệu mặc định do `scripts/migrate-master.ts` dựng cùng database — không có đường runtime nào
 * sinh ra master thứ hai. Chốt `§5.4` (nay ở `userService.deleteAccount`) chỉ giữ SÀN — luôn
 * còn ≥1; đây là TRẦN, không quá 1.
 */
export function canGrant(
  actor: { userId: string; grants: Grant[] },
  target: { userId: string; grant: Grant },
): boolean {
  if (target.grant.role === SYSTEM_ROLES.MASTER) return false

  // Không ai tự nâng quyền cho chính mình — kể cả master, để vết cấp quyền luôn có hai người.
  if (actor.userId === target.userId) return false

  return isMaster(actor.grants)
}

/** Thu hồi grant: cùng luật với cấp — ai cấp được thì thu hồi được. */
export function canRevoke(
  actor: { userId: string; grants: Grant[] },
  target: { userId: string; grant: Grant },
): boolean {
  return canGrant(actor, target)
}
