import { Types } from 'mongoose'
import { listingRepository, ModerationFilter } from './listing.repository'
import {
  CreateListingInput,
  ListingQuery,
  ListingReportQuery,
  NearbyQuery,
  UpdateListingInput,
} from './listing.schema'
import { IListing, IListingDocument } from './listing.model'
import { RoutingResult, defaultReachFor, routeListing } from './listing.routing'
import { reviewOf } from './listing.review'
import { PostingFee, postingFee } from './listing.pricing'
import { RECONCILE_LIMIT, listingExpiresAt, reconcileCutoff } from './listing.expiry.service'
import { BUCKET_FORMAT, bucketsBetween, resolveRange } from '../../common/report/timeBuckets'
import {
  QUOTA,
  QuotaVerdict,
  autoApprovalReason,
  checkQuota,
  isAutoApprove,
  ReviewedContent,
  touchesReviewedContent,
} from './listing.quota'
import { userRepository } from '../user/user.repository'
import { categoryRepository } from '../category/category.repository'
import {
  MACHINE_REVIEW,
  bannedContentReason,
  bannedPhraseIn,
  medianOf,
  reviewByMachine,
} from '../moderation/moderation.machine'
import type { MachineHold } from '../moderation/moderation.machine'
import { notificationService } from '../notification/notification.service'
import { bannedPhraseService } from '../banned-phrase/banned-phrase.service'
import { listingProductService } from '../listing-product/listing-product.service'
import { categoryService } from '../category/category.service'
import { categoryTemplateService } from '../category-template/category-template.service'
import { organizationRepository } from '../organization/organization.repository'
import { membershipRepository } from '../membership/membership.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { roleGrantService } from '../role-grant/role-grant.service'
import { trustRepository } from '../trust/trust.repository'
import { CLEAN_APPROVALS_PER_LEVEL, MAX_TRUST_LEVEL } from '../trust/trust.policy'
import {
  Grant,
  canBumpListing,
  canModerateAnyInOrg,
  canApproveListing,
  canTakedownListing,
} from '../../common/authz/policy'
import { BadRequestError, ConflictError, NotFoundError, ForbiddenError } from '../../common/errors'
import {
  ACTION_BY_DECISION,
  LISTING_STATUS,
  MODERATION_ACTION,
  MODERATION_QUEUE,
  ModerationAction,
  ModerationDecision,
  LISTING_REACH,
  ListingReach,
  PUBLICLY_READABLE_REACHES,
  PUBLIC_LISTING_STATUSES,
  REPORT_TIMEZONE,
  REPORT_GRANULARITY,
  TENANT_STATUS,
  isWardOfProvince,
  type RejectionSeverity,
} from '../../common/constants'
import { slugifyWithSuffix } from '../../common/utils/slugify'
import { currentScope, runUnscoped } from '../../common/tenant/tenantContext'
import {
  parsePagination,
  buildPaginationMeta,
  PaginationParams,
} from '../../common/utils/pagination'

/**
 * Chốt phạm vi THẬT của một thao tác duyệt.
 *
 * Route cố tình chỉ hỏi "có duyệt được thứ gì đó trong org này không" (`requireOrgModerator`,
 * rule 5). Dừng ở đó thì một quản lý org: (1) tự ghim được tin TRỤC CÔNG KHAI của thành viên
 * lên trang chung, bỏ qua người phụ trách danh mục — trái đúng thứ `listing.routing.ts` chốt;
 * và (2) vì nhánh đọc công khai của `tenantPlugin` cho thấy mọi tin public đã duyệt, họ ẩn
 * được cả tin của người ngoài org.
 *
 * Trục nào luật nấy, cùng cặp hàm mà `listing.routing.ts` dùng để định tuyến: công khai → ô
 * (danh mục × tỉnh), nội bộ → chính org đó (staff phải đúng nhóm con).
 *
 * Nằm ở ĐÂY chứ không ở `moderation.service` như trước: `tenantPlugin` cố tình cho MỌI scope
 * ghi vào tin `organizationId: null` (trục danh mục không có tenant để ép), nên tầng dưới
 * không chặn gì được. Khi phép kiểm còn ở phía người gọi thì `report.service.resolve` — gọi
 * thẳng `setModerationStatus` — đi vòng qua nó, và một staff org ẩn được tin trục danh mục.
 *
 * **403 hay 404** không tuỳ tiện — hai mã trả lời hai câu hỏi khác nhau:
 *
 * - `403` khi bàn duyệt của chính người này ĐÃ liệt kê tin ra: tin công khai (hàng đợi danh mục
 *   là bảng chung, sự tồn tại của tin vốn không phải bí mật), hoặc tin của org mà họ có quyền
 *   duyệt ở đâu đó trong đó nhưng sai nhóm con. Giấu sự tồn tại lúc này chỉ làm người ta bối rối.
 * - `404` khi tin thuộc một org họ KHÔNG có chân nào cả. Đây là ranh giới tenant: xác nhận
 *   "id này có tồn tại" cho người ngoài org là một máy dò danh sách tin của tổ chức khác.
 */
/**
 * Hình chiếu của một tin lên bảng chính sách (`ListingTarget`) — MỘT bản cho cả ba chốt: thao
 * tác duyệt/gỡ (`assertCanActOnListing`), đẩy (`assertCanBumpListing`) và đọc (`getForViewer`).
 * Trước đây hai chốt đầu mỗi bên tự viết literal này; thêm chốt thứ ba là lúc ba bản sao bắt
 * đầu lệch nhau.
 */
function targetOf(listing: IListingDocument) {
  return {
    reach: listing.reach,
    organizationId: listing.organizationId?.toString() ?? null,
    unitId: listing.unitId?.toString() ?? null,
    categoryId: listing.category.toString(),
    provinceCode: listing.provinceCode,
    wardCode: listing.wardCode,
  }
}

/**
 * Chốt thẩm quyền cho MỘT thao tác của bàn duyệt.
 *
 * `action` quyết định dùng cửa nào: `APPROVE` đi theo đúng trục của tin, `TAKEDOWN` mở thêm cho
 * nhóm sở hữu tin (xem `canTakedownListing`). Mọi call-site tra `ACTION_BY_DECISION` chứ không
 * tự phán, nên lớp ngoài và lớp trong không thể nói hai điều khác nhau.
 *
 * Thứ tự nhánh lỗi giữ nguyên và KHÔNG được đảo: nhánh công khai phải đứng trước nhánh 404, vì
 * một tin công khai `organizationId: null` sẽ rơi nhầm vào `!orgId → 404` nếu đảo.
 */
export function assertCanActOnListing(
  listing: IListingDocument,
  grants: Grant[],
  action: ModerationAction,
): void {
  const orgId = listing.organizationId?.toString() ?? null
  const allowed =
    action === MODERATION_ACTION.TAKEDOWN
      ? canTakedownListing(grants, targetOf(listing))
      : canApproveListing(grants, targetOf(listing))
  if (allowed) return

  if (listing.reach === LISTING_REACH.MARKETPLACE) {
    throw new ForbiddenError('Tin trên sàn do người phụ trách danh mục duyệt, không phải tổ chức')
  }

  // Tin nội bộ của một org mà người này không có quyền duyệt gì bên trong: với họ, tin này
  // không tồn tại.
  if (!orgId || !canModerateAnyInOrg(grants, orgId)) {
    throw new NotFoundError('Listing not found')
  }

  throw new ForbiddenError('Tin này không thuộc phạm vi duyệt của bạn')
}

/**
 * Chốt thẩm quyền ĐẨY TIN. Cùng luật 403/404 với `assertCanActOnListing`: giấu sự tồn tại
 * của tin chỉ khi người hỏi không có chân nào trong org của nó.
 *
 * Thông điệp 403 nói ra HẠNG còn thiếu, không nói "không có quyền": người bấm nút này thường
 * là staff nhóm — họ duyệt tin được nên đang tưởng mình đẩy được, và câu trả lời hữu ích là
 * "việc này thuộc quản trị nhóm" chứ không phải một lời từ chối trơn.
 */
export function assertCanBumpListing(listing: IListingDocument, grants: Grant[]): void {
  const orgId = listing.organizationId?.toString() ?? null
  if (canBumpListing(grants, targetOf(listing))) return

  if (listing.reach === LISTING_REACH.MARKETPLACE) {
    throw new ForbiddenError('Tin trên sàn chỉ người phụ trách danh mục này đẩy được')
  }

  if (!orgId || !canModerateAnyInOrg(grants, orgId)) {
    throw new NotFoundError('Listing not found')
  }

  throw new ForbiddenError('Đẩy tin là việc của quản trị nhóm, không phải người duyệt tin')
}

/** Kết quả `validateForCategory` — alias để `toListingDoc` không phải khai lại hình của nó. */
type ValidatedForCategory = Awaited<ReturnType<typeof categoryTemplateService.validateForCategory>>

/** Chỉ gọi khi `templateId` khác null — caller đã kiểm, đây là chỗ dựng hình cho gọn. */
const toTemplateRef = (v: ValidatedForCategory): IListing['templateRef'] => ({
  id: new Types.ObjectId(v.templateId!),
  version: v.version,
  isFallback: v.isFallback,
})

/**
 * Bối cảnh của người đăng tại thời điểm đăng. Controller dựng từ scope + membership + grants,
 * service không tự đi hỏi lại — một nguồn duy nhất, không có chỗ cho hai câu trả lời lệch nhau.
 */
export interface ListingAuthor {
  id: string
  /** Org hoạt động. `null` = đăng ở trục danh mục. */
  organizationId: string | null
  isMember: boolean
  unitId: string | null
  /** Bậc uy tín ở TRỤC ĐANG ĐĂNG — controller chọn đúng nguồn (membership hay PublicTrust). */
  trustLevel: number
  /** Chuỗi tin sạch liên tiếp. Chỉ `postingStanding` cần — xem lý do ở đó. */
  cleanApprovals: number
}

function toListingDoc(
  input: CreateListingInput,
  author: ListingAuthor,
  poster: { name: string; contact: string; avatar: string },
  routed: RoutingResult,
  reach: ListingReach,
  provinceCode: string | null,
  wardCode: string | null,
  validated: ValidatedForCategory,
): Partial<IListing> {
  const expiresAt = listingExpiresAt()
  return {
    title: input.title,
    slug: slugifyWithSuffix(input.title, Date.now().toString(36)),
    description: input.description,
    price: input.price,
    isNegotiable: input.isNegotiable ?? false,
    canDeliver: input.canDeliver ?? false,
    condition: input.condition,
    images: input.images,
    category: new Types.ObjectId(input.categoryId),
    seller: new Types.ObjectId(author.id),
    posterName: poster.name,
    posterContact: poster.contact,
    posterAvatar: poster.avatar,
    // Bỏ HẲN key khi người đăng không chọn khu vực, thay vì ghi một subdoc rỗng — tin không
    // có `location` và tin có `location: {}` phải là cùng một thứ khi lọc.
    ...(input.location && { location: input.location }),
    // Ba field dưới đây đến từ `validateForCategory`, KHÔNG từ `input`: giá trị đã ép kiểu,
    // key lạ đã bị loại, và `attrs` chỉ còn field lọc được.
    attributes: new Map(Object.entries(validated.attributes)),
    attrs: validated.attrs,
    // Vắng hẳn khi chưa seed template nào — `templateRef` trỏ vào một bản ghi không tồn tại
    // còn tệ hơn là không có nó.
    ...(validated.templateId && { templateRef: toTemplateRef(validated) }),
    // Bốn field dưới đây do thuật toán định tuyến quyết định, không do client gửi lên.
    reach,
    provinceCode,
    wardCode,
    organizationId: routed.organizationId ? new Types.ObjectId(routed.organizationId) : null,
    unitId: routed.unitId ? new Types.ObjectId(routed.unitId) : null,
    status: routed.status,
    expiresAt,
  }
}

/**
 * `provinceCode` là snapshot CỨNG. Nguồn theo thứ tự: người đăng chọn → tỉnh của org. Tin
 * trục danh mục bắt buộc phải có tỉnh vì chính nó quyết định ai duyệt.
 */
async function resolveProvinceCode(
  input: CreateListingInput,
  targetOrgId: string | null,
  reach: ListingReach,
): Promise<string | null> {
  const picked = input.provinceCode ?? input.location?.province
  if (picked) return picked

  // Tỉnh của org ĐÍCH, không phải org của người đăng: người ngoài gửi tin vào nhóm ở tỉnh
  // khác thì tin thuộc về tỉnh của nhóm đó.
  if (targetOrgId) {
    const org = await organizationRepository.findById(targetOrgId)
    if (org?.provinceCode) return org.provinceCode
  }

  /*
   * Chỉ bậc `marketplace` mới bắt buộc: không có tỉnh thì không xác định được ai duyệt.
   *
   * `group_open` KHÔNG rơi vào đây dù nó cũng đọc được công khai — nó vẫn do chính nhóm duyệt,
   * nên nó không cần ô định tuyến nào. Đổi điều kiện này thành "khác members" là bắt mọi nhóm
   * công khai phải chọn tỉnh cho từng tin trong nhóm.
   */
  if (reach === LISTING_REACH.MARKETPLACE) {
    throw new BadRequestError('Thiếu tỉnh/thành: tin lên sàn cần tỉnh để xác định người duyệt')
  }
  return null
}

/**
 * `wardCode` là cấp thứ hai của khoá định tuyến. Nguồn DUY NHẤT là `location.ward` — không có
 * fallback theo org như tỉnh: org có địa chỉ, nhưng "phường của org" không nói được tin này nằm
 * ở phường nào, mà đó mới là thứ quyết định ai duyệt.
 */
function resolveWardCode(
  input: CreateListingInput,
  provinceCode: string | null,
  reach: ListingReach,
): string | null {
  const ward = input.location?.ward?.trim() ?? ''
  if (!ward) {
    // Cùng chốt `MARKETPLACE` với `resolveProvinceCode`, cùng lý do.
    if (reach === LISTING_REACH.MARKETPLACE) {
      throw new BadRequestError('Thiếu phường/xã: tin lên sàn cần phường để xác định người duyệt')
    }
    return null
  }

  // Cặp phải khớp: `provinceCode` có thể do người đăng gửi tường minh và khác tỉnh trong
  // `location` — lúc đó (tỉnh, phường) là một ô không tồn tại, không ai duyệt được tin.
  if (provinceCode && !isWardOfProvince(provinceCode, ward)) {
    throw new BadRequestError(`"${ward}" không thuộc ${provinceCode}`)
  }
  return ward
}
interface TargetOrg {
  orgId: string | null
  /** Tư cách thành viên tại ĐÚNG org đích, không phải org đang nằm trong scope. */
  isMember: boolean
  unitId: string | null
  allowOutsiderPosts: boolean
  /** Nhóm đích có công khai không — quyết định bậc mặc định và tính hợp lệ của `group_open`. */
  isPublic: boolean
}

/**
 * `!== false` chứ không `=== true`: nhóm tạo trước ngày có field `isPublic` không mang field đó,
 * và cả hệ thống coi chúng là công khai (`PUBLIC = { isPublic: { $ne: false } }` bên repository).
 * So `=== true` ở đây là bắt riêng nhóm cũ phải đăng tin kín trong khi chúng vẫn hiện ở mọi
 * danh sách công khai — hai câu trả lời khác nhau cho cùng một nhóm.
 */
const isOrgPublic = (org: { isPublic?: boolean } | null): boolean => org?.isPublic !== false

/**
 * Org đích của một tin, tư cách người đăng tại org đó, và org đó có nhận tin người ngoài không.
 *
 * **`orgId` gửi lên THẮNG org suy từ scope.** Đây là chốt dễ sai nhất cả file:
 * `resolveTenant` tự chọn org khi người dùng chỉ thuộc đúng một org, nên bản cũ (`if
 * (author.isMember || !input.orgId)`) khiến một thành viên org A gửi `orgId` của org B bị
 * nuốt mất lựa chọn — tin rơi vào org A, KHÔNG một tiếng động. Với nghiệp vụ "ai cũng đăng
 * được vào nhóm khác" thì đó lại đúng là ca phổ biến nhất.
 *
 * Tư cách thành viên vì thế phải tra lại theo org ĐÍCH: cùng một người vừa là thành viên org A
 * vừa là người ngoài với org B, và hai vai đó đi hai hàng đợi khác nhau.
 */
async function resolveTargetOrg(
  input: CreateListingInput,
  author: ListingAuthor,
): Promise<TargetOrg> {
  if (!input.orgId) {
    // Nạp org của scope để biết `isPublic` — bậc mặc định phụ thuộc nó. Bản cũ không nạp gì ở
    // nhánh này và hard-code `allowOutsiderPosts: false`, một bất đối xứng vốn đã mong manh.
    const own = author.organizationId
      ? await organizationRepository.findById(author.organizationId)
      : null
    return {
      orgId: author.organizationId,
      isMember: author.isMember,
      unitId: author.unitId,
      allowOutsiderPosts: false,
      isPublic: isOrgPublic(own),
    }
  }

  const org = await organizationRepository.findActiveById(input.orgId)
  if (!org) throw new NotFoundError('Tổ chức không tồn tại hoặc đã bị khoá')

  const [full, membership] = await Promise.all([
    organizationRepository.findById(org._id),
    membershipRepository.findActive(author.id, org._id),
  ])

  return {
    orgId: org._id.toString(),
    isMember: Boolean(membership),
    unitId: membership?.unitId?.toString() ?? null,
    allowOutsiderPosts: Boolean(full?.allowOutsiderPosts),
    isPublic: isOrgPublic(full),
  }
}

async function hasCategoryModerator(
  categoryId: string,
  provinceCode: string,
  wardCode: string | null,
): Promise<boolean> {
  const grants = await roleGrantRepository.listByCategoryCell(categoryId, provinceCode, wardCode)
  return grants.length > 0
}

/** 409 chứ không 403: người dùng không thiếu quyền, họ chỉ đang chiếm hết slot của chính mình. */
function quotaError(quota: QuotaVerdict): Error {
  if (quota.reason === 'blocked_by_rejections') {
    return new ForbiddenError(
      `Bạn có ${QUOTA.REJECTION_BLOCK} tin bị từ chối trong ${QUOTA.REJECTION_WINDOW_DAYS} ngày — ` +
        'quyền đăng tạm khoá, liên hệ quản trị để mở lại',
    )
  }
  return new ConflictError(
    `Bạn đang có ${quota.pending}/${quota.limit} tin chờ duyệt — chờ duyệt xong rồi đăng tiếp`,
  )
}

/**
 * Chốt CHÍNH CHỦ, đọc NGOÀI scope tenant — cửa duy nhất cho mọi thao tác của chủ tin
 * (`update`, `remove`, `renew`, `markSold`, và lượt đọc dựng form sửa).
 *
 * Bản scoped (`assertOwner`) đã bỏ: nó không chặn được lượt ghi xuyên tenant nào (xem dưới)
 * mà chỉ chặn chính chủ, nên giữ hai biến thể chỉ là giữ một cái bẫy.
 *
 * Khoá `seller` lấy từ token nên đã hẹp hơn mọi scope; áp thêm trục vào đây thì bảng "tin của
 * tôi" (`paginateMine`, cũng unscoped) hiện ra tin mà bấm vào lại 404. Hai nhóm rơi đúng vào
 * đó: tin nội bộ của org KHÁC org đang active trên header, và tin `hidden`/`pending` — cả hai
 * đều nằm ngoài predicate public, dù là tin của chính người đang gọi.
 *
 * DÙNG cho cả `update`/`remove`. Bản trước cố ý không dùng, với lý do 'hai đường đó ghi nội
 * dung nên vẫn phải nằm trong trục' — đo ra thì lý do đó không giữ được gì mà chặn mất chính
 * chủ: `organizationId` khai `immutable: true` ở `tenantPlugin`, nên một lượt sửa KHÔNG thể
 * chuyển tin sang org khác; thứ duy nhất trục chặn được là chủ tin sửa tin của mình khi đang
 * đứng ở org khác (hoặc không đứng ở org nào — ca của người thuộc nhiều nhóm).
 *
 * Đo trên dữ liệu thật, tài khoản 24 tin: 13 tin (`pending`/`hidden`) trả 404 ở CẢ `GET` lẫn
 * `PATCH`, và tin `active` nội bộ cũng 404 khi thiếu `X-Org-Id`. Sau khi đã chốt `seller`
 * từ token — khoá hẹp hơn mọi tenant scope — thì lượt ghi phải chạy unscoped nốt, kẻo
 * predicate ghi của plugin lọc trắng và `findByIdAndUpdate` ghi RỖNG mà không báo gì.
 */
async function assertOwnerUnscoped(id: string, userId: string) {
  const listing = await runUnscoped('chính chủ trả lời về tin của mình', () =>
    listingRepository.findById(id).exec(),
  )
  if (!listing) throw new NotFoundError('Listing not found')
  if (listing.seller.toString() !== userId) throw await notMineError(id)
  return listing
}

/**
 * Lỗi trả cho người KHÔNG phải chủ tin: 403 hay 404, tuỳ họ vốn đã đọc được tin đó chưa.
 *
 * Lượt đọc CÓ SCOPE của bản cũ tạo ra luật này như một tác dụng phụ, và hai test khoá cả hai
 * nửa của nó: `listing-expiry` đòi 403 khi người lạ chạm vào một tin ĐANG HIỂN THỊ (ai cũng
 * thấy nó, giấu đi chỉ làm thông điệp vô nghĩa), còn `tenant-isolation` đòi 404 khi chủ org A
 * chạm vào tin NỘI BỘ của org B (403 là thừa nhận tin đó tồn tại, đủ để dò id).
 *
 * Đọc unscoped làm mất tác dụng phụ đó — lượt sửa đầu của tôi trả 404 cho cả hai ca và
 * `listing-expiry` đỏ ngay. Nên luật phải viết ra: một lượt đọc THEO SCOPE của người hỏi,
 * chỉ chạy trên nhánh đã thất bại, để phân biệt 'bạn thấy được nhưng không phải của bạn' với
 * 'với bạn thì tin này không tồn tại'.
 */
async function notMineError(id: string): Promise<Error> {
  const visible = await listingRepository.findById(id).exec()
  return visible
    ? new ForbiddenError('You can only modify your own listing')
    : new NotFoundError('Listing not found')
}

/**
 * Vị thế đăng tin, diễn giải cho CHÍNH CHỦ đọc — xem `postingStandingSchema` về việc vì sao
 * không trả con số bậc.
 *
 * `cleanApprovalsNeeded` đếm theo `MAX_TRUST_LEVEL`: mỗi bậc cần `CLEAN_APPROVALS_PER_LEVEL`
 * bài sạch, nên khoảng cách còn lại là số bậc thiếu nhân lên, TRỪ phần chuỗi đã đi được trong
 * bậc hiện tại. Đây là con số người bán thật sự cần ("còn 5 tin nữa"), khác hẳn con số bậc mà
 * họ không diễn giải được — nên nó phải đúng: nói quá còn tệ hơn không nói gì.
 */
function postingStanding(
  author: ListingAuthor,
  recentRejections: number,
  lastRejectionAt: Date | null,
) {
  const levelsShort = Math.max(0, MAX_TRUST_LEVEL - author.trustLevel)
  // `nextTrust` thăng bậc theo `cleanApprovals % CLEAN_APPROVALS_PER_LEVEL`, nên người đã có 4
  // tin sạch chỉ còn thiếu 1 để lên bậc. Không trừ phần này thì con số luôn nói quá với bất kỳ
  // ai đang dở dang — đúng những người cần nó nhất.
  const doneInLevel = author.cleanApprovals % CLEAN_APPROVALS_PER_LEVEL
  return {
    canSelfPublish: isAutoApprove(author.trustLevel, recentRejections),
    cleanApprovalsNeeded:
      levelsShort === 0 ? 0 : levelsShort * CLEAN_APPROVALS_PER_LEVEL - doneInLevel,
    // Án phạt hết đúng khi lượt từ chối gần nhất rơi ra khỏi cửa sổ 7 ngày.
    penalty:
      recentRejections > 0 && lastRejectionAt
        ? {
            rejections: recentRejections,
            until: new Date(
              lastRejectionAt.getTime() + QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString(),
          }
        : null,
  }
}

/** Mốc đầu cửa sổ đếm tin bị từ chối — create và update phải hỏi cùng một câu hỏi. */
function rejectionWindowStart(): Date {
  return new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * FLAG của cổng nội dung — chỉ chạy khi fast-path uy tín SẮP MỞ, vì tin vào PENDING kiểu gì
 * máy quét cũng chấm đầy đủ vài phút sau (tiết kiệm 2 query cho đường thường).
 *
 * Dùng CHUNG bảng luật với máy quét (`reviewByMachine`) chứ không viết bộ thứ hai — hai
 * signals đã biết chắc theo ngữ cảnh (không án từ chối, danh mục không bắt duyệt tay, vì
 * khác đi thì fast-path đã đóng trước khi tới đây) truyền cứng false.
 */
async function fastPathFlagged(
  input: CreateListingInput,
  sellerId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<MachineHold[]> {
  const dupSince = new Date(Date.now() - MACHINE_REVIEW.DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const [prices, hasDuplicateTitle] = await Promise.all([
    listingRepository.sampleActivePrices(categoryId, MACHINE_REVIEW.PRICE_SAMPLE_SIZE),
    // excludeId null: tin đang xét chưa được ghi, không có gì để tự loại.
    listingRepository.hasRecentDuplicateTitle(sellerId, input.title, null, dupSince),
  ])
  const screening = reviewByMachine({
    title: input.title,
    description: input.description,
    // Rỗng vì cụm cấm đã xét TRƯỚC ở tầng create — hàm này chỉ còn lo phần FLAG.
    bannedPhrases: [],
    price: input.price,
    categoryMedianPrice: medianOf(prices),
    hasRecentRejection: false,
    hasDuplicateTitle,
    categoryRequiresReview: false,
  })
  // Trả về ĐÚNG các hold, không phải một boolean: đây là dữ liệu duy nhất giải thích được cho
  // người đăng vì sao tin của họ dừng lại — ném nó đi rồi chỉ ghi "flagged" là câm.
  return screening.verdict === 'hold' ? screening.holds : []
}

/**
 * DTO cho CHÍNH CHỦ = DTO công khai + `review`.
 *
 * `toJSON` của model cố ý xoá `autoApproval`/`machineReview` khỏi DTO chung — hồ sơ kiểm duyệt
 * không thuộc về trang tin ai cũng đọc. Nên phần giải thích được ghép ở ĐÂY, chỉ trên hai đường
 * `/listings/mine*`, và đã qua `reviewOf` để dịch mã thành câu — client không bao giờ thấy mã.
 */
function toOwnerListing(doc: IListingDocument) {
  return { ...doc.toJSON(), review: reviewOf(doc) }
}

/**
 * Gắn danh thiếp nhóm vào tin — MỘT truy vấn cho cả trang, không phải một cho mỗi tin.
 *
 * Tra lúc ĐỌC chứ không snapshot vào tin như `posterName`. Hai lý do, và lý do thứ hai mới là
 * lý do bắt buộc:
 *
 * 1. Tấm badge này DẪN tới hồ sơ nhóm. Một cái tên cũ trỏ sang một trang mang tên mới là chỉ
 *    dẫn sai — khác hẳn `posterName`, vốn đúng nghĩa là ảnh chụp danh tính lúc đăng.
 * 2. Nó gác theo `isPublic`, mà cờ đó ĐỔI ĐƯỢC. Snapshot chụp lúc nhóm còn công khai sẽ tiếp
 *    tục rò tên nhóm sau khi master gạt nhóm sang riêng tư — đúng lớp lỗi mà cascade trong
 *    `organizationService.setVisibility` sinh ra để chặn.
 *
 * NHÓM RIÊNG TƯ KHÔNG CÓ BADGE. `isPublic: false` nghĩa là nhóm không muốn bị tìm thấy; dán
 * tên nó lên một tin cả sàn đọc được là phá đúng lời hứa đó, bằng một con đường không ai nghĩ
 * tới khi gạt cái cờ kia. Người trong nhóm vẫn biết mình đang ở đâu — họ đọc tin đó từ bảng
 * tin của chính nhóm.
 *
 * Nhóm đã xoá hoặc đang khoá cũng không có badge: `findByIds` bỏ bản ghi xoá mềm, còn hồ sơ
 * của org đang khoá thì không mở được, nên dẫn người ta tới đó là dẫn vào ngõ cụt.
 */
async function withOrgBadge<T extends { organizationId: Types.ObjectId | null; toJSON(): unknown }>(
  items: T[],
) {
  const ids = [...new Set(items.map((i) => i.organizationId?.toString()).filter(Boolean))]
  if (ids.length === 0) return items.map((i) => i.toJSON())

  const orgs = await organizationRepository.findByIds(ids.map((id) => new Types.ObjectId(id!)))
  const badge = new Map(
    orgs
      .filter((o) => o.isPublic !== false && o.status === TENANT_STATUS.ACTIVE)
      .map((o) => [
        o._id.toString(),
        { id: o._id.toString(), name: o.name, avatarUrl: o.avatarUrl },
      ]),
  )

  return items.map((i) => ({
    ...(i.toJSON() as Record<string, unknown>),
    org: badge.get(i.organizationId?.toString() ?? '') ?? null,
  }))
}

export const listingService = {
  /**
   * Đăng tin. Bốn chốt, theo đúng thứ tự này:
   *
   * 1. **Cổng nội dung** (`moderation.machine.ts`) — đứng TRƯỚC mọi phép tính uy tín:
   *    cụm cấm → tin thành REJECTED ngay từ cửa; nội dung đáng ngờ → tước quyền tự đăng.
   * 2. **Định tuyến** (`routeListing`) — quyết định hàng đợi + trạng thái. Chạy trước quota vì
   *    chính nó nói cho ta biết đây là bucket nào (thành viên / người ngoài / trục danh mục).
   * 3. **Quota** — backpressure theo bucket, cộng chốt chặn tin bị từ chối xuyên trục.
   * 4. Ghi, với `organizationId`/`visibility`/`provinceCode` do bước 2 quyết định, không phải
   *    do client gửi lên.
   */
  async create(input: CreateListingInput, author: ListingAuthor) {
    // Zod chỉ chốt được `categoryId` đúng dạng 24 hex. Không kiểm tra ở đây thì một id hợp lệ
    // về hình thức nhưng không trỏ tới danh mục nào vẫn tạo ra tin — và tin đó rơi khỏi mọi
    // bộ lọc danh mục mà không ai biết vì sao.
    const category = await categoryService.assertUsable(input.categoryId)

    // Ngay sau `assertUsable` vì nó cần một danh mục có thật để tra template. Đây là chốt duy
    // nhất cho `attributes`: zod chỉ chặn được hình dạng, còn "field nào bắt buộc, option nào
    // hợp lệ" thì nằm trong DB nên middleware tĩnh không với tới (plan §0.2).
    const validated = await categoryTemplateService.validateForCategory(
      input.categoryId,
      input.attributes,
    )

    const seller = await userRepository.findById(author.id)
    if (!seller) throw new NotFoundError('User not found')

    const target = await resolveTargetOrg(input, author)
    // Bậc mặc định phụ thuộc nhóm ĐÍCH, nên phải tính SAU khi đã biết nhóm nào.
    const reach = input.reach ?? defaultReachFor({ orgId: target.orgId, isPublic: target.isPublic })
    const provinceCode = await resolveProvinceCode(input, target.orgId, reach)
    const wardCode = resolveWardCode(input, provinceCode, reach)
    const sellerId = new Types.ObjectId(author.id)
    const categoryId = new Types.ObjectId(input.categoryId)

    const recentRejections = await listingRepository.countRecentRejections(
      sellerId,
      rejectionWindowStart(),
    )

    // ── CỔNG NỘI DUNG — lớp 0, đứng TRƯỚC mọi phép tính uy tín ─────────────────
    // BLOCK (cụm cấm) chạy cho MỌI tin, 0 query. Tin dính không bị chặn ở HTTP mà thành
    // REJECTED ngay từ cửa: `moderation.at` cho `countRecentRejections` đếm, nên dò luật
    // 3 lần trong 7 ngày là REJECTION_BLOCK tự khoá quyền đăng — 400 suông thì dò vô hạn.
    const banned = bannedPhraseIn(
      input.title + '\n' + input.description,
      await bannedPhraseService.phrases(),
    )

    const wouldAutoApprove =
      !banned && isAutoApprove(author.trustLevel, recentRejections) && !category.requireManualReview
    const holds = wouldAutoApprove ? await fastPathFlagged(input, sellerId, categoryId) : []
    const contentFlagged = holds.length > 0

    const routed = routeListing({
      reach,
      orgId: target.orgId,
      orgIsPublic: target.isPublic,
      isMember: target.isMember,
      allowOutsiderPosts: target.allowOutsiderPosts,
      hasCategoryModerator:
        reach === LISTING_REACH.MARKETPLACE
          ? await hasCategoryModerator(input.categoryId, provinceCode!, wardCode)
          : false,
      unitId: author.unitId,
      // Cờ của danh mục là phủ quyết, đứng SAU phép tính uy tín; và cổng nội dung phủ quyết
      // TẤT CẢ — đủ bậc nhưng nội dung bị FLAG thì vẫn xuống hàng đợi.
      autoApprove: wouldAutoApprove && !contentFlagged,
    })

    const isOutsider = routed.queue === MODERATION_QUEUE.ORG_OUTSIDER
    const pendingCount =
      reach === LISTING_REACH.MARKETPLACE
        ? await listingRepository.countPendingInCategory(sellerId, categoryId)
        : await listingRepository.countPendingInOrg(
            sellerId,
            new Types.ObjectId(routed.organizationId!),
          )

    const quota = checkQuota({
      trustLevel: author.trustLevel,
      isOutsider,
      recentRejections,
      pendingCount,
    })
    if (!quota.allowed) throw quotaError(quota)

    // Chụp lại quyết định NGAY tại chỗ nó được đưa ra: bậc uy tín đổi liên tục, hỏi lại sau
    // sự cố thì con số đã khác từ lâu.
    const autoApproval = {
      trustLevel: author.trustLevel,
      // Chỉ ghi khi có — mảng rỗng trên mọi tin tự lên là một field nhiễu.
      ...(holds.length > 0 ? { holds } : {}),
      reason: banned
        ? ('content_banned' as const)
        : autoApprovalReason({
            autoApproved: routed.status === LISTING_STATUS.ACTIVE,
            trustLevel: author.trustLevel,
            recentRejections,
            categoryRequiresReview: category.requireManualReview,
            isOutsider,
            contentFlagged,
          }),
    }

    const doc = toListingDoc(
      input,
      author,
      // `showPhone` mặc định false, nên tin mới KHÔNG mang số điện thoại trừ khi người bán chủ
      // động bật. Đọc ở đây chứ không lúc trả tin: `posterContact` là snapshot, và đọc xuyên
      // sang `User` lúc render tin sẽ là đúng thứ mà multi-tenant.convention §2.3 cấm.
      {
        name: seller.name,
        contact: seller.showPhone ? (seller.phone ?? '') : '',
        avatar: seller.avatar,
      },
      routed,
      reach,
      provinceCode,
      wardCode,
      validated,
    )
    doc.autoApproval = autoApproval

    if (banned) {
      doc.status = LISTING_STATUS.REJECTED
      // Cụm cấm là vi phạm quy định sàn, không phải "tin sai sót" — mức độ phải nói đúng thế.
      doc.moderation = {
        reason: bannedContentReason(banned),
        byName: 'Hệ thống',
        at: new Date(),
        severity: 'violation',
      }
    }

    /*
     * Nhóm đích do BODY chỉ ra, còn scope tenant thì do HEADER dựng — hai nguồn LỆCH được, và
     * `tenantPlugin` chặn mọi lượt ghi có `organizationId` khác `ownOrgId` của request.
     *
     * Nên chốt ở đây là "org đã định tuyến có khác org của request không", KHÔNG phải "người
     * đăng có phải người ngoài không". Bản trước hỏi câu thứ hai (`queue === ORG_OUTSIDER`) và
     * bỏ sót đúng ca thường gặp nhất: THÀNH VIÊN đăng vào nhóm mình, mà `ownOrgId` lại không
     * phải nhóm đó — người thuộc hai nhóm trở lên thì `resolveTenant` không suy ra org nào
     * (`memberships.length !== 1` → `null`), còn người đang mở nhóm A mà đăng vào nhóm B thì
     * header trỏ sang A. Cả hai đều nổ `CrossTenantWriteError`, tức HTTP 500 — không phải 400,
     * vì lỗi đó nghĩa là "code ghi sai trục", không phải "yêu cầu sai".
     *
     * Khai `runUnscoped` là an toàn vì thẩm quyền đã chốt xong TRƯỚC dòng này, không phải bỏ
     * qua: `resolveTargetOrg` tra tư cách thành viên với chính id trong body, `routeListing`
     * chặn người ngoài khi nhóm tắt `allowOutsiderPosts` và chặn cả việc mượn tên nhóm cho tin
     * công khai. `doc` mang `organizationId` tường minh — cùng lối `moderation.service` ghi vết
     * duyệt dưới org SỞ HỮU tin thay vì org của người duyệt.
     */
    const scopedOrgId = currentScope()?.ownOrgId?.toString() ?? null
    const crossesTenant = routed.organizationId !== null && routed.organizationId !== scopedOrgId
    const listing = await (crossesTenant
      ? runUnscoped('đăng tin vào nhóm đích do body chỉ ra, đã qua resolveTargetOrg', () =>
          listingRepository.create(doc),
        )
      : listingRepository.create(doc))

    if (banned) {
      // Cùng lời với người duyệt tay từ chối — người đăng không cần biết ai chặn, chỉ cần vì sao.
      await notificationService.notifyUser({
        organizationId: listing.organizationId,
        userId: listing.seller,
        title: 'Tin của bạn bị từ chối',
        body: `"${listing.title}" — ${bannedContentReason(banned)}`,
      })
    }

    /*
     * Tin TỰ ĐĂNG (uy tín đủ bậc) lên bảng ngay tại đây, không đi qua bàn duyệt — nên đây là
     * một trong HAI chỗ báo cho cả nhóm. Chỗ còn lại là `notifyPoster` nhánh `ACTIVE`, cho tin
     * phải chờ quản trị bấm duyệt.
     *
     * Ràng `status === ACTIVE` chứ không báo vô điều kiện: tin `pending`/`rejected` chưa ai xem
     * được, báo sớm là mời cả nhóm bấm vào một trang không mở ra được.
     */
    if (listing.status === LISTING_STATUS.ACTIVE) {
      await notificationService.notifyGroupOfListing(listing)
    }

    return listing
  },

  /** Catalog gói tin CÔNG KHAI — chỉ gói đang mở bán; master quản qua /listing-products. */
  productCatalog() {
    return listingProductService.listEnabled()
  },

  /** Báo giá một lượt đăng — controller đọc để đính vào response, luật nằm ở `listing.pricing.ts`. */
  feeQuote(author: ListingAuthor, categoryId?: string): PostingFee {
    return postingFee({ trustLevel: author.trustLevel, categoryId })
  },

  /** Trạng thái quota để client hiện "bạn còn N slot" thay vì để người dùng đoán (§8.4). */
  async quotaStatus(author: ListingAuthor, categoryId?: string) {
    const sellerId = new Types.ObjectId(author.id)
    const since = new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const [recentRejections, lastRejectionAt] = await Promise.all([
      listingRepository.countRecentRejections(sellerId, since),
      listingRepository.lastRejectionAt(sellerId, since),
    ])

    const pendingCount = categoryId
      ? await listingRepository.countPendingInCategory(sellerId, new Types.ObjectId(categoryId))
      : author.organizationId
        ? await listingRepository.countPendingInOrg(
            sellerId,
            new Types.ObjectId(author.organizationId),
          )
        : 0

    /*
     * Tin cần đối soát đi KÈM quota, không thành một endpoint riêng: màn chặn-trước-khi-đăng
     * hỏi cả hai thứ cùng lúc ("còn N slot" + "N tin cũ này còn không?"), mà hai request rời
     * nhau thì màn đó phải chờ cái chậm hơn rồi mới vẽ được gì.
     */
    const needsReconcile = await listingRepository.findNeedingReconcile(
      author.id,
      reconcileCutoff(),
      RECONCILE_LIMIT,
    )

    return {
      ...checkQuota({
        trustLevel: author.trustLevel,
        isOutsider: Boolean(author.organizationId) && !author.isMember,
        recentRejections,
        pendingCount,
      }),
      needsReconcile: needsReconcile.map((l) => ({
        _id: l._id.toString(),
        title: l.title,
        // Ảnh đầu là ảnh bìa ở mọi chỗ khác — giữ nguyên quy ước, đừng để màn này tự chọn khác.
        image: l.images[0] ?? '',
        status: l.status,
        expiresAt: l.expiresAt!,
      })),
      // Field phí sống trong hợp đồng API từ GIAI ĐOẠN MIỄN PHÍ — xem listing.pricing.ts.
      fee: this.feeQuote(author, categoryId),
      standing: postingStanding(author, recentRejections, lastRejectionAt),
    }
  },

  /**
   * Bộ lọc thuộc tính động phải qua HAI chốt trước khi chạm DB — cả hai đều ở service, không
   * ở zod: zod là middleware tĩnh, mà tập key hợp lệ chỉ biết được sau khi tra template
   * (cùng lý do `validateForCategory` đứng ở đây chứ không ở `validate()`).
   *
   * 1. **Phải có `category`.** Không có nó thì không có template nào để đối chiếu, và
   *    `attrs.k` là key tự do — mỗi lượt lọc thành một lần quét toàn bảng.
   * 2. **Key phải `filterable` trong đúng template đó.** Chấp nhận key bất kỳ vừa mở đường
   *    quét bảng, vừa biến bộ lọc thành công cụ dò xem thuộc tính nào tồn tại trong dữ liệu.
   *
   * Ném 400 chứ không lặng lẽ bỏ key sai: client lọc bằng key gõ nhầm mà vẫn nhận 200 sẽ tin
   * là kết quả đã được lọc.
   */
  async list(query: ListingQuery) {
    if (query.attrs) {
      if (!query.category) {
        throw new BadRequestError('Lọc theo thuộc tính cần chọn danh mục trước')
      }
      const template = await categoryTemplateService.getForCategory(query.category)
      const allowed = new Set(template.fields.filter((f) => f.filterable).map((f) => f.key))
      const rejected = Object.keys(query.attrs).filter((k) => !allowed.has(k))
      if (rejected.length > 0) {
        throw new BadRequestError(
          `Không lọc được theo: ${rejected.join(', ')} — danh mục này không mở lọc cho chúng`,
        )
      }
    }

    const pagination = parsePagination(query)
    const { items, total } = await listingRepository.paginate(query, pagination)
    return {
      items: await withOrgBadge(items),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Đẩy tin lên đầu bảng tin. MIỄN PHÍ, không qua gói nào — xem `canBumpListing` cho ai được.
   *
   * Chỉ ghi `rankAt`, KHÔNG đụng `createdAt`: bảng tin xếp theo `rankAt` (`paginate`), còn
   * `createdAt` là lịch sử — sửa nó thì tin trông như vừa đăng ở mọi bề mặt khác, kể cả trang
   * chi tiết và thống kê.
   *
   * Chỉ tin ACTIVE: pending/rejected/sold/expired không nằm trên bảng tin, đẩy chúng là một
   * thao tác báo thành công mà không dịch được gì — người bấm sẽ tưởng nó có tác dụng.
   *
   * Đọc và ghi ĐỀU unscoped, chốt thật là `assertCanBumpListing` kẹp ở giữa — cùng lý do đã
   * ghi ở `setModerationStatus`: tenant scope không diễn đạt nổi thẩm quyền của trục danh mục,
   * nên người phụ trách danh mục (không thuộc nhóm nào) sẽ không đụng được tin công khai mang
   * badge nhóm dù chính họ có thẩm quyền trên trục đó.
   */
  async bump(id: string, grants: Grant[]) {
    const listing = await runUnscoped('bump: đọc tin để xét thẩm quyền theo trục', () =>
      listingRepository.findById(id).exec(),
    )
    if (!listing) throw new NotFoundError('Listing not found')
    assertCanBumpListing(listing, grants)

    if (listing.status !== LISTING_STATUS.ACTIVE) {
      throw new BadRequestError('Chỉ đẩy được tin đang hiển thị trên bảng tin')
    }

    const updated = await runUnscoped('bump: ghi rankAt đã qua chốt thẩm quyền', () =>
      listingRepository.updateById(id, { rankAt: new Date() }).exec(),
    )
    return updated!
  },

  /**
   * Gia hạn tin — đường của CHÍNH CHỦ, trả lời "vẫn còn" cho câu hỏi hết hạn.
   *
   * KHÔNG chạm `rankAt`. Gia hạn mà kèm đẩy tin thì cách rẻ nhất để lên đầu bảng là để tin
   * hết hạn rồi bấm gia hạn — đẩy tin là quyền của quản trị (`bump`), giữ hai việc rời nhau.
   *
   * Chỉ nhận `active` (còn hạn, gia hạn sớm) và `expired`. Mọi trạng thái khác 400: bật
   * `hidden`/`rejected` lên `active` là để chủ tin tự lật phán quyết của người duyệt, còn
   * `sold` thì phải đăng tin mới chứ không hồi sinh tin đã bán.
   */
  async renew(id: string, userId: string) {
    const existing = await assertOwnerUnscoped(id, userId)
    if (existing.status !== LISTING_STATUS.ACTIVE && existing.status !== LISTING_STATUS.EXPIRED) {
      throw new BadRequestError('Chỉ gia hạn được tin đang hiển thị hoặc đã hết hạn')
    }

    const updated = await runUnscoped('gia hạn: ghi sau khi đã chốt chính chủ', () =>
      listingRepository.updateById(id, {
        status: LISTING_STATUS.ACTIVE,
        expiresAt: listingExpiresAt(),
      }),
    )
    return updated!
  },

  /**
   * Đánh dấu đã bán — đường của CHÍNH CHỦ, trả lời "đã bán".
   *
   * Idempotent: tin đã `sold` trả về nguyên trạng chứ không 400. Nút này sẽ nằm trong push
   * notification (đợt sau), nơi bấm hai lần là chuyện thường và một lỗi đỏ ở lần thứ hai chỉ
   * làm người bán tưởng lần đầu thất bại.
   *
   * `hidden`/`rejected`/`pending` thì 400 — cùng lý do `renew`: chúng là phán quyết của
   * người duyệt, chủ tin không được đi vòng qua bằng cách tự đổi trạng thái.
   */
  async markSold(id: string, userId: string) {
    const existing = await assertOwnerUnscoped(id, userId)
    if (existing.status === LISTING_STATUS.SOLD) return existing
    if (existing.status !== LISTING_STATUS.ACTIVE && existing.status !== LISTING_STATUS.EXPIRED) {
      throw new BadRequestError('Chỉ đánh dấu đã bán cho tin đang hiển thị hoặc đã hết hạn')
    }

    const updated = await runUnscoped('đã bán: ghi sau khi đã chốt chính chủ', () =>
      listingRepository.updateById(id, { status: LISTING_STATUS.SOLD }),
    )
    return updated!
  },

  async nearby(query: NearbyQuery) {
    const pagination = parsePagination(query)
    const items = await listingRepository.findByArea(
      {
        province: query.province,
        ward: query.ward,
        exclude: query.exclude,
        extra: { status: LISTING_STATUS.ACTIVE },
      },
      pagination,
    )
    return {
      items: await withOrgBadge(items),
      meta: { page: pagination.page, limit: pagination.limit },
    }
  },

  /**
   * Đọc MỘT tin theo id cho một NGƯỜI XEM cụ thể — quyền xét theo QUAN HỆ, không theo tenant
   * scope của request. Dùng chung cho màn chi tiết, mở chat và lưu tin.
   *
   * Vì sao không để `tenantPlugin` lọc như cũ: scope dựng từ `X-Org-Id` — "org đang thao tác"
   * của app. Người thuộc HAI nhóm mở tin nội bộ của nhóm A trong lúc app đứng ở nhóm B (hoặc
   * chưa đứng ở nhóm nào — fallback tự suy org chỉ chạy khi họ thuộc ĐÚNG MỘT nhóm) nhận 404 cho
   * chính tin họ vừa thấy ở hồ sơ nhóm. Câu hỏi đúng không phải "request này chỉ ra nhóm nào"
   * mà là "người này có chân trong nhóm sở hữu tin không" — cùng nguyên tắc `chat.service` đã
   * chốt cho hội thoại: quyền đến từ quan hệ, không từ tenant.
   *
   * Luật, theo trục của tin — và mọi trục đều đòi tin ĐÃ PUBLIC (`PUBLIC_LISTING_STATUSES`),
   * y như `incrementView` cũ; tin chờ duyệt đọc qua `getForModeration`:
   * - `public`: ai cũng đọc, kể cả khách.
   * - `org_internal`: phải đã đăng nhập VÀ là thành viên active của `organizationId`. Người có
   *   quyền duyệt trong nhóm đó (manager được bổ nhiệm, master) cũng đọc được dù không phải
   *   thành viên — bàn duyệt của họ vốn liệt kê tin này, giấu ở đây chỉ làm hai màn nói ngược.
   *
   * Mọi nhánh từ chối đều **404**, không 403: 403 là xác nhận id này tồn tại, đủ để người ngoài
   * dò danh sách tin nội bộ của một tổ chức (convention §8). `runUnscoped` an toàn vì chốt nằm
   * ngay dưới — cùng cách `getForModeration` và `assertOwnerUnscoped` làm.
   */
  async getForViewer(id: string, viewerId: string | null): Promise<IListingDocument> {
    const listing = await runUnscoped('listing: đọc theo id, xét quyền theo quan hệ', () =>
      listingRepository.findById(id).exec(),
    )
    if (!listing || !PUBLIC_LISTING_STATUSES.includes(listing.status)) {
      throw new NotFoundError('Listing not found')
    }
    // Hai bậc công khai đọc được không cần quan hệ nào với nhóm — đây chính là chỗ "nhóm công
    // khai mà tin vẫn kín" được gỡ.
    if (PUBLICLY_READABLE_REACHES.includes(listing.reach)) return listing

    if (viewerId && listing.organizationId) {
      const member = await membershipRepository.findActive(viewerId, listing.organizationId)
      if (member) return listing
      // Chỉ tra grants khi KHÔNG phải thành viên: đây là nhánh hiếm, đừng trả giá cho nó ở
      // mọi lượt mở tin.
      const grants = await roleGrantService.grantsOf(viewerId)
      if (canApproveListing(grants, targetOf(listing))) return listing
    }
    throw new NotFoundError('Listing not found')
  },

  /**
   * Màn chi tiết: đọc qua `getForViewer` rồi cộng lượt xem. Cộng SAU khi qua chốt — bộ đếm không
   * được động vì một lượt 404.
   */
  async getByIdAndTrackView(id: string, viewerId: string | null) {
    const listing = await this.getForViewer(id, viewerId)
    await listingRepository.bumpView(listing._id)
    listing.viewCount += 1
    // Qua cùng một cửa với danh sách: màn chi tiết và thẻ tin phải nói CÙNG một điều về nhóm,
    // kể cả ở ca nhóm vừa bị gạt sang riêng tư.
    const [withBadge] = await withOrgBadge([listing])
    return withBadge
  },

  /**
   * Đọc tin cho BÀN DUYỆT — unscoped, vì thẩm quyền ở đây đến từ trục của tin chứ không từ
   * tenant scope (xem `setModerationStatus`). Người phụ trách danh mục không có org trong
   * scope, nên `getById` thường sẽ trả 404 ngay trước khi ai kịp xét quyền.
   *
   * Không rò rỉ gì: caller BẮT BUỘC đưa tin này qua `assertCanActOnListing` trước khi làm
   * bất cứ điều gì với nó.
   */
  async getForModeration(id: string) {
    const listing = await runUnscoped('moderation: đọc tin để xét thẩm quyền theo trục', () =>
      listingRepository.findById(id).exec(),
    )
    if (!listing) throw new NotFoundError('Listing not found')
    return listing
  },

  /**
   * Đọc nhiều tin theo id, GIỮ NGUYÊN thứ tự mảng id truyền vào — nguồn của thứ tự là bảng
   * favorite (mới lưu trước), còn Mongo thì trả `$in` theo thứ tự của nó.
   *
   * Tin ngoài scope hoặc đã gỡ bị loại, nên mảng trả về có thể ngắn hơn mảng id.
   */
  async getManyByIds(ids: Types.ObjectId[]) {
    if (ids.length === 0) return []
    const items = await listingRepository.findByIds(ids)
    const byId = new Map(items.map((item) => [item._id.toString(), item]))
    return ids.map((id) => byId.get(id.toString())).filter((item) => item !== undefined)
  },

  /**
   * Cộng/trừ bộ đếm lượt lưu. Tách khỏi feature favorite vì `Listing` là model của feature này
   * — favorite chạm thẳng vào nó là hai feature cùng ghi một collection.
   */
  adjustFavoriteCount(id: Types.ObjectId, delta: number) {
    return listingRepository.adjustFavoriteCount(id, delta)
  },

  /**
   * Ẩn mọi tin còn sống của một người (tài khoản bị khoá). Trả về số tin đã ẩn.
   *
   * MỞ KHOÁ không có chiều ngược: tin đã ẩn ở lại ẩn, người dùng tự mở lại từng tin nếu còn
   * muốn bán — chúng đã rời bảng một thời gian, tự bật hàng loạt là hồi sinh cả tin đã hết thời.
   */
  async hideAllFromSeller(
    sellerId: Types.ObjectId,
    input: { reason: string; byUserId: string },
  ): Promise<number> {
    const actor = await userRepository.findById(input.byUserId)
    const result = await listingRepository.hideAllBySeller(sellerId, {
      reason: input.reason,
      byUserId: new Types.ObjectId(input.byUserId),
      byName: actor?.name ?? 'Quản trị hệ thống',
      at: new Date(),
    })
    return result.modifiedCount
  },

  async update(id: string, userId: string, input: UpdateListingInput) {
    const existing = await assertOwnerUnscoped(id, userId)

    // Cổng nội dung chặn cả đường SỬA — khác create, ở đây 400 thẳng chứ không đẻ bản ghi
    // REJECTED mới (đây là request sửa, tin đã tồn tại). Soi nội dung SAU KHI GHÉP chứ không
    // chỉ phần gửi lên: tin cũ lọt lưới từ trước ngày có cổng thì không được sửa vặt cho tới
    // khi dọn sạch phần cấm — gửi kèm bản chữ sạch trong cùng patch là qua.
    const banned = bannedPhraseIn(
      (input.title ?? existing.title) + '\n' + (input.description ?? existing.description),
      await bannedPhraseService.phrases(),
    )
    if (banned) throw new BadRequestError(bannedContentReason(banned))

    if (input.categoryId) await categoryService.assertUsable(input.categoryId)

    const { categoryId, location, attributes, ...rest } = input
    const update: Partial<IListing> = { ...rest }
    if (categoryId) update.category = new Types.ObjectId(categoryId)
    if (location) update.location = location

    const targetCategory = categoryId ?? existing.category.toString()

    /*
     * Validate lại khi `attributes` HOẶC `categoryId` đổi — không chỉ khi `attributes` đổi.
     *
     * Đổi riêng danh mục là ca dễ bỏ sót nhất: thuộc tính cũ thuộc template cũ, giữ nguyên thì
     * tin xe máy mang `batteryHealth` của điện thoại và `attrs` trỏ vào field template mới
     * không có. Validate theo danh mục MỚI sẽ tự loại chúng — đó chính là việc "loại key lạ".
     */
    if (attributes || categoryId) {
      const validated = await categoryTemplateService.validateForCategory(
        targetCategory,
        // Danh mục đổi mà client không gửi lại `attributes` thì vẫn phải lọc bộ cũ qua template
        // mới, nên nguồn là `attributes ?? bộ đang lưu` chứ không phải `attributes ?? {}`.
        attributes ?? Object.fromEntries(existing.attributes),
        // Giữ nguyên danh mục → ghim template của chính tin này, để form sửa và server xét
        // cùng một bộ field. Đổi danh mục → template cũ vô nghĩa, lấy bản mới nhất.
        categoryId ? undefined : existing.templateRef?.version,
      )

      update.attributes = new Map(Object.entries(validated.attributes))
      update.attrs = validated.attrs
      if (validated.templateId) update.templateRef = toTemplateRef(validated)
    }

    /*
     * Tin ĐANG HIỂN THỊ mà đổi nội dung người duyệt từng nhìn thì phải xếp hàng lại.
     *
     * Không có chốt này thì cả cơ chế duyệt chỉ tốn đúng một lần lách: đăng một tin sạch, đợi
     * nó lên bảng, rồi sửa thành bất cứ thứ gì — `update` không hề chạm `status` nên tin ở lại
     * `ACTIVE` vĩnh viễn mà không ai xem lại.
     *
     * Ngoại lệ là người bán ĐỦ ĐIỀU KIỆN TỰ ĐĂNG ngay lúc này: xoá tin rồi đăng lại họ vẫn ra
     * `ACTIVE`, nên giữ tin của họ lại chỉ đẻ thêm việc cho người duyệt chứ không chặn được gì.
     */
    const reviewedBefore: ReviewedContent = {
      title: existing.title,
      description: existing.description,
      price: existing.price,
      images: existing.images,
      categoryId: existing.category.toString(),
    }

    const touches = touchesReviewedContent(reviewedBefore, input)

    // Máy đã chấm BẢN CŨ — nội dung đổi thì phán quyết đó hết giá trị. Null mở lại cửa cho
    // job quét (query của nó là `machineReview: null`), áp cho cả tin đang chờ lẫn tin bị
    // đá về chờ ở khối dưới.
    if (touches) update.machineReview = null

    if (existing.status === LISTING_STATUS.ACTIVE && touches) {
      const [category, trustLevel, recentRejections] = await Promise.all([
        categoryRepository.findById(targetCategory).exec(),
        trustRepository.levelOf(userId),
        listingRepository.countRecentRejections(existing.seller, rejectionWindowStart()),
      ])
      const categoryRequiresReview = category?.requireManualReview ?? false

      if (!isAutoApprove(trustLevel, recentRejections) || categoryRequiresReview) {
        // Về `PENDING` chứ không `PENDING_UNVERIFIED`: hàng đợi người-ngoài dành cho tin CHƯA
        // ai duyệt. Tin này đã qua tay người duyệt một lượt — thứ cần xem lại là nội dung mới,
        // không phải tư cách người đăng.
        update.status = LISTING_STATUS.PENDING
        update.autoApproval = {
          trustLevel,
          reason: autoApprovalReason({
            autoApproved: false,
            trustLevel,
            recentRejections,
            categoryRequiresReview,
            isOutsider: false,
          }),
        }
      }
    }

    // `.exec()` NGAY trong callback: trả về Query chưa chạy là pre hook của plugin nổ sau khi
    // AsyncLocalStorage đã thoát ngữ cảnh → 'Missing tenant context'. Cùng lối `bump` ở dưới.
    return runUnscoped('sửa tin: ghi sau khi đã chốt chính chủ', () =>
      listingRepository.updateById(id, update).exec(),
    )
  },

  async remove(id: string, userId: string) {
    await assertOwnerUnscoped(id, userId)
    return runUnscoped('xoá tin: ghi sau khi đã chốt chính chủ', () =>
      listingRepository.softDelete(id).exec(),
    )
  },

  /**
   * Đọc tin của CHÍNH CHỦ để dựng form sửa — MỌI trạng thái, mọi trục.
   *
   * Không dùng được `getByIdAndTrackView`: nó lọc `status ∈ PUBLIC_LISTING_STATUSES` ngay ở
   * repository (`incrementView`), nên tin `pending`/`hidden`/`rejected` của chính mình cũng
   * trả 404 — kể cả khi `X-Org-Id` đã đúng. Đó là đúng luật cho một endpoint CÔNG KHAI
   * (quy tắc 7 của AGENT), nên mở nó ra là sai chỗ; chính chủ cần một cửa riêng.
   *
   * Cũng KHÔNG tăng `viewCount`: chủ tin mở form sửa không phải một lượt xem.
   */
  async getOwn(id: string, userId: string) {
    return toOwnerListing(await assertOwnerUnscoped(id, userId))
  },

  /* ------------------------- dành cho bàn quản trị ------------------------- */
  /*
   * Bốn hàm dưới đây là seam cho feature `moderation`, không phải API công khai: chúng ép
   * `status` tường minh, thứ mà `listingQuerySchema` cố tình không cho client đặt (quy tắc 7
   * của AGENT — endpoint public không bao giờ trả tin ngoài PUBLIC_LISTING_STATUSES).
   *
   * Chúng KHÔNG ghi vết kiểm toán: audit thuộc về `moderation`, và để listing gọi ngược lên
   * đó sẽ tạo vòng import.
   */

  /** Tin của chính mình — `sellerId` lấy từ token, không nhận từ query, nên không xem trộm được. */
  async listMine(sellerId: string, query: ListingQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await listingRepository.paginateMine(sellerId, pagination)
    return {
      items: items.map(toOwnerListing),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  listForModeration(filter: ModerationFilter, pagination: PaginationParams) {
    return listingRepository.paginateForModeration(filter, pagination)
  },

  async setModerationStatus(
    id: string,
    next: {
      /**
       * Chỉ ba quyết định, không phải mọi `ListingStatus`: `ACTION_BY_DECISION` chỉ định nghĩa
       * hạng thao tác cho ba giá trị này, và siết kiểu ở đây là cách bảng tra không bao giờ bị
       * tra hụt.
       */
      status: ModerationDecision
      reason?: string
      byUserId: string
      byName: string
      /** Chỉ ghi khi TỪ CHỐI — với duyệt/ẩn thì mức độ không có nghĩa gì. */
      severity?: RejectionSeverity
    },
    grants: Grant[],
  ) {
    // Đọc và ghi ĐỀU unscoped, người gác thật là `assertCanActOnListing` kẹp ở giữa.
    //
    // Tenant scope không diễn đạt nổi thẩm quyền của trục danh mục: nhánh GHI của `tenantPlugin`
    // chỉ cho đụng `organizationId: null` hoặc org trong scope, nên một người phụ trách danh mục
    // (không thuộc nhóm nào) không sửa được tin công khai MANG BADGE nhóm — dù chính họ là người
    // có thẩm quyền trên trục đó. Ép scope ở đây là ép sai chiều.
    //
    // An toàn không mất: `assertCanActOnListing` phân xử theo ĐÚNG trục của tin và chạy TRƯỚC
    // mọi lượt ghi, không call-site nào đi vòng được (chính nó là bản vá cho lỗ cũ của
    // `report.service`).
    const listing = await runUnscoped('moderation: đọc tin để xét thẩm quyền theo trục', () =>
      listingRepository.findById(id).exec(),
    )
    if (!listing) throw new NotFoundError('Listing not found')
    // Suy hạng thao tác từ CHÍNH quyết định đang ghi — cùng bảng với lớp ngoài, nên không có
    // khe nào để hai lớp phán khác nhau.
    assertCanActOnListing(listing, grants, ACTION_BY_DECISION[next.status])

    const updated = await runUnscoped('moderation: ghi phán quyết đã qua chốt thẩm quyền', () =>
      listingRepository
        .updateById(id, {
          status: next.status,
          moderation: {
            reason: next.reason,
            byUserId: new Types.ObjectId(next.byUserId),
            byName: next.byName,
            at: new Date(),
            ...(next.status === LISTING_STATUS.REJECTED && { severity: next.severity }),
          },
        })
        .exec(),
    )
    return updated!
  },

  /**
   * Đổi ô (danh mục/tỉnh) của một tin. Tin quay về ĐẦU hàng đợi mới: nó chưa từng được ai ở
   * ô mới nhìn qua, giữ nguyên thứ tự cũ là chen ngang hàng đợi của họ (§11.3).
   */
  async rerouteListing(id: string, input: { categoryId?: string; provinceCode?: string }) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')
    if (input.categoryId) await categoryService.assertUsable(input.categoryId)

    const update: Partial<IListing> = { status: LISTING_STATUS.PENDING }
    if (input.categoryId) update.category = new Types.ObjectId(input.categoryId)
    if (input.provinceCode) update.provinceCode = input.provinceCode

    const updated = await listingRepository.updateById(id, update)
    return updated!
  },

  /** Cùng lập luận unscoped với `setModerationStatus` — thẩm quyền đến từ trục của tin. */
  async removeByModerator(id: string, grants: Grant[]) {
    const listing = await runUnscoped('moderation: đọc tin để xét thẩm quyền trước khi gỡ', () =>
      listingRepository.findById(id).exec(),
    )
    if (!listing) throw new NotFoundError('Listing not found')
    assertCanActOnListing(listing, grants, MODERATION_ACTION.TAKEDOWN)

    return runUnscoped('moderation: gỡ tin đã qua chốt thẩm quyền', () =>
      listingRepository.softDelete(id).exec(),
    )
  },

  /**
   * Số liệu bàn duyệt, với `byDay` ĐÃ ĐIỀN ĐỦ CỘT — đúng `trendDays` cột, kết thúc hôm nay.
   *
   * Điền ở đây vì đây là phễu chung của cả ba bàn đọc nó (org, trục danh mục, hệ thống); để
   * từng service tự điền là ba bản sao của cùng một phép lịch, và bản thứ ba sẽ quên.
   *
   * Mongo chỉ trả cột CÓ dữ liệu. Thiếu bước này thì nhóm đăng 3 tin rải rác trong 14 ngày ra
   * biểu đồ 3 điểm cách đều — một hình dạng chưa từng xảy ra — còn nhóm chưa có tin nào ra
   * mảng RỖNG, thứ đã làm `TrendChart` dựng path không có lệnh `M` và đỏ cả app ở tầng native.
   *
   * Cột ngoài khung bị bỏ: `statsForModeration` lùi trọn trendDays × 24h nên có thể chạm sang
   * một ngày nữa chỉ được phủ một phần. Một cột nửa ngày đứng cạnh các cột đủ ngày là so sánh
   * sai; khung đã hứa "14 ngày" thì trả đúng 14.
   */
  async moderationStats(trendDays: number) {
    const stats = await listingRepository.statsForModeration(trendDays)

    const now = new Date()
    const from = new Date(now.getTime() - (trendDays - 1) * 24 * 60 * 60 * 1000)
    const found = new Map(stats.byDay.map((row) => [row._id, row]))
    const byDay = bucketsBetween(from, now, REPORT_GRANULARITY.DAY).map(
      (day) => found.get(day) ?? { _id: day, approved: 0, pending: 0 },
    )

    return { ...stats, byDay }
  },

  /** Dữ liệu định giá cho hệ Xu — xem ghi chú dài ở `listingRepository.postingStats`. */
  /**
   * Báo cáo đăng tin theo thời gian — toàn hệ thống (master, không kèm org) hoặc của MỘT nhóm
   * (quản trị nhóm, hoặc master đang đứng trong một org). Xem `listingRepository.reportSeries`.
   *
   * Service làm đúng hai việc mà tầng DB không làm được: chốt khoảng thời gian (mặc định, trần)
   * và ĐIỀN CỘT RỖNG. Mongo chỉ trả về cột CÓ dữ liệu, nên một tuần không ai đăng tin sẽ biến
   * mất khỏi mảng và biểu đồ nối thẳng hai đầu thành một đoạn dốc chưa từng xảy ra.
   */
  async listingReport(query: ListingReportQuery, organizationId: Types.ObjectId | null = null) {
    const range = resolveRange(query)
    const rows = await listingRepository.reportSeries(
      range.from,
      range.to,
      BUCKET_FORMAT[range.granularity],
      organizationId,
    )

    const byBucket = new Map(rows.map((row) => [row._id, row]))
    const points = bucketsBetween(range.from, range.to, range.granularity).map((bucket) => {
      const row = byBucket.get(bucket)
      return {
        bucket,
        posts: row?.posts ?? 0,
        sellers: row?.sellers.length ?? 0,
        active: row?.active ?? 0,
        pending: row?.pending ?? 0,
        rejected: row?.rejected ?? 0,
      }
    })

    /*
     * Tổng cộng KHÔNG có `sellers`: cộng số người bán của từng cột lại là đếm một người N
     * lần nếu họ đăng ở N ngày khác nhau. Muốn "số người bán khác nhau trong cả kỳ" thì phải là
     * một phép gộp riêng trên toàn khoảng — chưa cần tới nên chưa làm, và thà thiếu một con số
     * còn hơn bày ra một con số sai mà trông hợp lý.
     */
    const totals = points.reduce(
      (acc, p) => ({
        posts: acc.posts + p.posts,
        active: acc.active + p.active,
        pending: acc.pending + p.pending,
        rejected: acc.rejected + p.rejected,
      }),
      { posts: 0, active: 0, pending: 0, rejected: 0 },
    )

    return {
      granularity: range.granularity,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      timezone: REPORT_TIMEZONE,
      truncated: range.truncated,
      points,
      totals,
    }
  },

  postingStats(days: number) {
    return listingRepository.postingStats(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
  },
}
