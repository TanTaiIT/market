import { AsyncLocalStorage } from 'node:async_hooks'
import { Types } from 'mongoose'
import { TenantScopeMissingError } from './tenant.errors'

/**
 * Vế thứ hai của scope: quyền đọc trên TRỤC DANH MỤC (tin công khai).
 *
 * Nằm trong scope chứ không nằm ở repository là có chủ ý: repository quên một điều kiện thì
 * dữ liệu chưa duyệt lọt ra ngoài, còn ở đây nó do middleware dựng một lần và `tenantPlugin`
 * áp cho mọi query — cùng lý do khiến vế org nằm ở đây.
 */
export type PublicAxisScope =
  /** Ai cũng có: chỉ thấy tin công khai ĐÃ duyệt. */
  | { mode: 'approved' }
  /**
   * Manager/staff trục danh mục: thấy cả tin chưa duyệt, nhưng chỉ trong ô của mình.
   *
   * `cells: null` = không giới hạn địa lý (master, hoặc grant cấp tỉnh toàn quốc). Mỗi ô:
   * `wards: null` = cả tỉnh (grant cấp tỉnh), mảng = đúng những phường được cấp.
   */
  | {
      mode: 'moderator'
      categoryIds: Types.ObjectId[]
      cells: { province: string; wards: string[] | null }[] | null
    }

export interface TenantScope {
  /** Org của chính request. Mọi thao tác GHI trục org luôn bị ép về đúng org này. */
  ownOrgId: Types.ObjectId | null
  /**
   * Org được phép ĐỌC ở trục org — PHẠM VI QUẢN TRỊ của request này.
   *
   * Hầu như luôn là 0 hoặc 1 phần tử (org mà request đang đứng trong); chỉ master đọc xuyên tổ
   * chức mới có nhiều. Mọi cổng trong `auth.middleware` phân quyền theo `ownOrgId` rồi giao cho
   * tầng truy vấn lọc theo mảng này, nên hai thứ phải khớp nhau — nới mảng này ra là phá đẳng
   * thức đó theo kiểu fail-open. Cần "đọc nội dung của mọi nhóm mình ở trong" thì dùng
   * `memberOrgIds`, đừng đụng vào đây.
   */
  readableOrgIds: Types.ObjectId[]
  /**
   * Mọi org người gọi đang là THÀNH VIÊN — quyền đọc NỘI DUNG, không phải quyền quản trị.
   *
   * Tách hẳn khỏi `readableOrgIds` là có chủ ý. Người thuộc hai nhóm phải thấy tin của cả hai
   * trên bảng tin mà không cần "chọn nhóm đang thao tác", nhưng họ KHÔNG vì thế mà được đọc
   * hàng đợi duyệt hay nhật ký của nhóm kia. Gộp hai nhu cầu vào một mảng thì quên một cổng là
   * một lượt đọc xuyên nhóm không ai thấy; tách ra thì quên nối trường này chỉ là "thiếu tin
   * trên bảng tin" — một lỗi nhìn thấy được.
   *
   * Chỉ `listingPublicPredicate` đọc nó. Bàn quản trị thu nó về rỗng — xem `requireOrgModerator`.
   */
  memberOrgIds: Types.ObjectId[]
  /** `null` = request này không được đọc gì ở trục danh mục. */
  publicAxis: PublicAxisScope | null
  /** Chỉ set trong `runUnscoped`: bỏ filter, và caller phải tự mang organizationId. */
  unscopedReason?: string
}

const storage = new AsyncLocalStorage<TenantScope>()

export function runWithTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentScope(): TenantScope | undefined {
  return storage.getStore()
}

export function requireScope(operation: string): TenantScope {
  const scope = storage.getStore()
  if (!scope) throw new TenantScopeMissingError(operation)
  return scope
}

/**
 * Org hoạt động của request. Service gọi hàm này thay vì nhận `organizationId` qua tham số:
 * tham số đi qua nhiều tầng là nhiều chỗ có thể truyền nhầm org, còn scope thì chỉ có một
 * nguồn duy nhất là middleware đã đối chiếu membership.
 */
export function requireOwnOrgId(operation: string): Types.ObjectId {
  const scope = requireScope(operation)
  if (!scope.ownOrgId) throw new TenantScopeMissingError(operation)
  return scope.ownOrgId
}

/**
 * Scope mặc định của một request chưa gắn org: vẫn đọc được tin công khai đã duyệt.
 *
 * `memberOrgIds` vẫn truyền vào được, và đây là ca THƯỜNG GẶP NHẤT chứ không phải ngoại lệ:
 * người thuộc từ hai nhóm trở lên mà không gửi header thì không có org nào "đang thao tác", mà
 * tin của cả hai nhóm vẫn phải hiện trên bảng tin của họ.
 */
export function publicOnlyScope(memberOrgIds: Types.ObjectId[] = []): TenantScope {
  return { ownOrgId: null, readableOrgIds: [], memberOrgIds, publicAxis: { mode: 'approved' } }
}

/**
 * Thu scope về ĐÚNG MỘT NHÓM cho một bàn quản trị. Hai trường, hai đường rò khác nhau.
 *
 * Mọi cổng mở ra bàn quản trị của một org phải gọi hàm này. Bàn đó lọc theo `readableOrgIds`,
 * nhưng `tenantPlugin` ghép các nhánh đọc bằng `$or` — nên mỗi trường còn sống dưới đây là một
 * vế `$or` nữa kéo dữ liệu ngoài nhóm vào một hàng đợi đáng lẽ chỉ nói về nhóm đó.
 *
 * - `memberOrgIds` → tin của nhóm B, chỉ vì người duyệt A tình cờ là thành viên B.
 * - `publicAxis`  → nhánh `listingPublicPredicate` bậc `approved`, tức MỌI tin ACTIVE công
 *   khai của TOÀN SÀN. Đây là vế rộng hơn hẳn vế trên và từng bị bỏ sót đúng một lần: bản
 *   trước chỉ xoá `memberOrgIds`, nên bàn quản trị của một nhóm 10 tin trả về 122 dòng.
 *
 * Không phải lỗ hổng — tin đó ai cũng đọc được ở bảng tin, và `assertCanActOnListing` chặn mọi
 * thao tác. Nhưng là một hàng đợi nói sai về phạm vi của chính nó.
 *
 * Xoá `publicAxis` KHÔNG chạm trục danh mục: `requireCategoryModerator` tự ghi đè trường này
 * bằng axis `moderator` của riêng nó, và hai route đó khai TRƯỚC `router.use` của trục org.
 */
export function narrowToOwnOrg(scope: TenantScope): TenantScope {
  return { ...scope, memberOrgIds: [], publicAxis: null }
}

/**
 * Thu scope về ĐÚNG TRỤC DANH MỤC cho bàn duyệt của trục đó — bản đối xứng của `narrowToOwnOrg`.
 *
 * `readableOrgIds` phải về rỗng, và đây là chỗ từng rò: `resolveTenant` mở nhánh org cho BẤT KỲ
 * thành viên nào gửi `X-Org-Id` (hoặc chỉ thuộc đúng một nhóm), rồi `tenantPlugin` ghép nhánh đó
 * với nhánh công khai bằng `$or`. Một giáo viên được cấp ô "Sách vở × Hà Nội" mở hàng đợi danh
 * mục là thấy luôn tin `pending`/`hidden`/`rejected` NỘI BỘ của trường mình — kèm
 * `moderation.reason` — dù bàn đó không nói gì về trường. `memberOrgIds` rỗng cùng lý do.
 *
 * `ownOrgId` giữ nguyên: nó chỉ chi phối đường GHI của trục org, không mở thêm đường đọc nào.
 */
export function narrowToPublicAxis(scope: TenantScope, axis: PublicAxisScope): TenantScope {
  return { ...scope, readableOrgIds: [], memberOrgIds: [], publicAxis: axis }
}

/**
 * Dùng cho code chạy NGOÀI request: seed, migration, background job.
 * Tên cố tình xấu và `reason` bắt buộc để `grep -rn "runUnscoped"` liệt kê đủ mọi chỗ
 * có quyền chạm dữ liệu xuyên tenant, kèm lý do ngay tại call site.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return storage.run(
    {
      ownOrgId: null,
      readableOrgIds: [],
      memberOrgIds: [],
      publicAxis: null,
      unscopedReason: reason,
    },
    fn,
  )
}
