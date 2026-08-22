import { Types } from 'mongoose'
import { listingRepository } from './listing.repository'
import { CreateListingInput, UpdateListingInput, ListingQuery, NearbyQuery } from './listing.schema'
import { IListing, IListingDocument } from './listing.model'
import { RoutingResult, routeListing } from './listing.routing'
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
import { notificationService } from '../notification/notification.service'
import { bannedPhraseService } from '../banned-phrase/banned-phrase.service'
import { categoryService } from '../category/category.service'
import { categoryTemplateService } from '../category-template/category-template.service'
import { organizationRepository } from '../organization/organization.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { trustRepository } from '../trust/trust.repository'
import { Grant, canModerateListing } from '../../common/authz/policy'
import { BadRequestError, ConflictError, NotFoundError, ForbiddenError } from '../../common/errors'
import {
  LISTING_STATUS,
  ListingStatus,
  MODERATION_QUEUE,
  POST_VISIBILITY,
} from '../../common/constants'
import { slugifyWithSuffix } from '../../common/utils/slugify'
import { runUnscoped } from '../../common/tenant/tenantContext'
import {
  parsePagination,
  buildPaginationMeta,
  PaginationParams,
} from '../../common/utils/pagination'

const LISTING_TTL_DAYS = 30

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
 * 403 chứ không 404: bàn duyệt vừa liệt kê tin này ra, giấu sự tồn tại của nó không còn nghĩa.
 */
export function assertCanModerateListing(listing: IListingDocument, grants: Grant[]): void {
  const allowed = canModerateListing(grants, {
    visibility: listing.visibility,
    organizationId: listing.organizationId?.toString() ?? null,
    unitId: listing.unitId?.toString() ?? null,
    categoryId: listing.category.toString(),
    provinceCode: listing.provinceCode,
  })
  if (allowed) return

  throw new ForbiddenError(
    listing.visibility === POST_VISIBILITY.PUBLIC
      ? 'Tin công khai do người phụ trách danh mục duyệt, không phải tổ chức'
      : 'Tin này không thuộc phạm vi duyệt của bạn',
  )
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
}

function toListingDoc(
  input: CreateListingInput,
  author: ListingAuthor,
  poster: { name: string; contact: string; avatar: string },
  routed: RoutingResult,
  provinceCode: string | null,
  validated: ValidatedForCategory,
): Partial<IListing> {
  const expiresAt = new Date(Date.now() + LISTING_TTL_DAYS * 24 * 60 * 60 * 1000)
  return {
    title: input.title,
    slug: slugifyWithSuffix(input.title, Date.now().toString(36)),
    description: input.description,
    price: input.price,
    isNegotiable: input.isNegotiable ?? false,
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
    visibility: input.visibility ?? POST_VISIBILITY.ORG_INTERNAL,
    provinceCode,
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
  author: ListingAuthor,
  visibility: string,
): Promise<string | null> {
  const picked = input.provinceCode ?? input.location?.province
  if (picked) return picked

  if (author.organizationId) {
    const org = await organizationRepository.findById(author.organizationId)
    if (org?.provinceCode) return org.provinceCode
  }

  // Chỉ trục công khai mới bắt buộc: không có tỉnh thì không xác định được ai duyệt.
  if (visibility === POST_VISIBILITY.PUBLIC) {
    throw new BadRequestError('Thiếu tỉnh/thành: tin công khai cần tỉnh để xác định người duyệt')
  }
  return null
}

/**
 * Org đích của một tin, và tin đó có được phép vào đó không.
 *
 * Người ngoài không có org trong scope: `resolveTenant` cố tình không mở scope org cho người
 * không phải thành viên khi ghi. Nên org đích phải đến từ `orgSlug` trong body — đúng cái slug
 * họ vừa xác nhận trên dropdown, cùng đường mà đơn xin tham gia đang đi.
 */
async function resolveTargetOrg(
  input: CreateListingInput,
  author: ListingAuthor,
): Promise<{ orgId: string | null; allowOutsiderPosts: boolean }> {
  if (author.isMember || !input.orgSlug) {
    return { orgId: author.organizationId, allowOutsiderPosts: false }
  }

  const org = await organizationRepository.findActiveBySlug(input.orgSlug)
  if (!org) throw new NotFoundError('Tổ chức không tồn tại hoặc đã bị khoá')

  const full = await organizationRepository.findById(org._id)
  return { orgId: org._id.toString(), allowOutsiderPosts: Boolean(full?.allowOutsiderPosts) }
}

async function hasCategoryModerator(categoryId: string, provinceCode: string): Promise<boolean> {
  const grants = await roleGrantRepository.listByCategoryProvince(categoryId, provinceCode)
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

async function assertOwner(id: string, userId: string) {
  const listing = await listingRepository.findById(id)
  // Tin của org khác đã bị scope loại từ tầng plugin -> null -> 404, không lộ tồn tại.
  if (!listing) throw new NotFoundError('Listing not found')
  if (listing.seller.toString() !== userId) {
    throw new ForbiddenError('You can only modify your own listing')
  }
  return listing
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
): Promise<boolean> {
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
  return screening.verdict !== 'approve'
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

    const visibility = input.visibility ?? POST_VISIBILITY.ORG_INTERNAL
    const provinceCode = await resolveProvinceCode(input, author, visibility)
    const sellerId = new Types.ObjectId(author.id)
    const categoryId = new Types.ObjectId(input.categoryId)

    const recentRejections = await listingRepository.countRecentRejections(
      sellerId,
      rejectionWindowStart(),
    )

    const target = await resolveTargetOrg(input, author)

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
    const contentFlagged = wouldAutoApprove
      ? await fastPathFlagged(input, sellerId, categoryId)
      : false

    const routed = routeListing({
      visibility,
      orgId: target.orgId,
      isMember: author.isMember,
      allowOutsiderPosts: target.allowOutsiderPosts,
      hasCategoryModerator:
        visibility === POST_VISIBILITY.PUBLIC
          ? await hasCategoryModerator(input.categoryId, provinceCode!)
          : false,
      unitId: author.unitId,
      // Cờ của danh mục là phủ quyết, đứng SAU phép tính uy tín; và cổng nội dung phủ quyết
      // TẤT CẢ — đủ bậc nhưng nội dung bị FLAG thì vẫn xuống hàng đợi.
      autoApprove: wouldAutoApprove && !contentFlagged,
    })

    const isOutsider = routed.queue === MODERATION_QUEUE.ORG_OUTSIDER
    const pendingCount =
      visibility === POST_VISIBILITY.PUBLIC
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
      provinceCode,
      validated,
    )
    doc.autoApproval = autoApproval

    if (banned) {
      doc.status = LISTING_STATUS.REJECTED
      doc.moderation = { reason: bannedContentReason(banned), byName: 'Hệ thống', at: new Date() }
    }

    // Người ngoài ghi vào org mà họ KHÔNG thuộc về: request này không có scope org (đúng thiết
    // kế), nên đây là một lối đi xuyên tenant thật sự và phải khai bằng `runUnscoped` — tin
    // mang `organizationId` tường minh, và tổ chức đã bật `allowOutsiderPosts` để mời nó vào.
    const listing = await (routed.queue === MODERATION_QUEUE.ORG_OUTSIDER
      ? runUnscoped('outsider post into org đã bật allowOutsiderPosts', () =>
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

    return listing
  },

  /** Trạng thái quota để client hiện "bạn còn N slot" thay vì để người dùng đoán (§8.4). */
  async quotaStatus(author: ListingAuthor, categoryId?: string) {
    const sellerId = new Types.ObjectId(author.id)
    const since = new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const recentRejections = await listingRepository.countRecentRejections(sellerId, since)

    const pendingCount = categoryId
      ? await listingRepository.countPendingInCategory(sellerId, new Types.ObjectId(categoryId))
      : author.organizationId
        ? await listingRepository.countPendingInOrg(
            sellerId,
            new Types.ObjectId(author.organizationId),
          )
        : 0

    return checkQuota({
      trustLevel: author.trustLevel,
      isOutsider: Boolean(author.organizationId) && !author.isMember,
      recentRejections,
      pendingCount,
    })
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
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
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
    return { items, meta: { page: pagination.page, limit: pagination.limit } }
  },

  async getByIdAndTrackView(id: string) {
    const listing = await listingRepository.incrementView(id)
    if (!listing) throw new NotFoundError('Listing not found')
    return listing
  },

  /**
   * Đọc tin mà KHÔNG tăng lượt xem — dành cho feature khác cần kiểm tra tin tồn tại (vd chat
   * mở hội thoại). Dùng `getByIdAndTrackView` ở đó sẽ thổi phồng lượt xem mỗi lần bấm nhắn tin.
   */
  async getById(id: string) {
    const listing = await listingRepository.findById(id)
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
    const existing = await assertOwner(id, userId)

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

    return listingRepository.updateById(id, update)
  },

  async remove(id: string, userId: string) {
    await assertOwner(id, userId)
    return listingRepository.softDelete(id)
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
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  listForModeration(status: ListingStatus | undefined, pagination: PaginationParams) {
    return listingRepository.paginateForModeration(status, pagination)
  },

  async setModerationStatus(
    id: string,
    next: { status: ListingStatus; reason?: string; byUserId: string; byName: string },
    grants: Grant[],
  ) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')
    assertCanModerateListing(listing, grants)

    const updated = await listingRepository.updateById(id, {
      status: next.status,
      moderation: {
        reason: next.reason,
        byUserId: new Types.ObjectId(next.byUserId),
        byName: next.byName,
        at: new Date(),
      },
    })
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

  async removeByModerator(id: string, grants: Grant[]) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')
    assertCanModerateListing(listing, grants)
    return listingRepository.softDelete(id)
  },

  moderationStats(trendDays: number) {
    return listingRepository.statsForModeration(trendDays)
  },
}
