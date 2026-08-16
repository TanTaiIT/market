import { Types } from 'mongoose'
import { listingRepository } from './listing.repository'
import { CreateListingInput, UpdateListingInput, ListingQuery, NearbyQuery } from './listing.schema'
import { IListing } from './listing.model'
import { RoutingResult, routeListing } from './listing.routing'
import { QUOTA, QuotaVerdict, checkQuota, isAutoApprove } from './listing.quota'
import { userRepository } from '../user/user.repository'
import { categoryService } from '../category/category.service'
import { organizationRepository } from '../organization/organization.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
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
  poster: { name: string; contact: string },
  routed: RoutingResult,
  provinceCode: string | null,
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
    // Bỏ HẲN key khi người đăng không chọn khu vực, thay vì ghi một subdoc rỗng — tin không
    // có `location` và tin có `location: {}` phải là cùng một thứ khi lọc.
    ...(input.location && { location: input.location }),
    attributes: input.attributes ? new Map(Object.entries(input.attributes)) : new Map(),
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

export const listingService = {
  /**
   * Đăng tin. Ba chốt, theo đúng thứ tự này:
   *
   * 1. **Định tuyến** (`routeListing`) — quyết định hàng đợi + trạng thái. Chạy trước quota vì
   *    chính nó nói cho ta biết đây là bucket nào (thành viên / người ngoài / trục danh mục).
   * 2. **Quota** — backpressure theo bucket, cộng chốt chặn tin bị từ chối xuyên trục.
   * 3. Ghi, với `organizationId`/`visibility`/`provinceCode` do bước 1 quyết định, không phải
   *    do client gửi lên.
   */
  async create(input: CreateListingInput, author: ListingAuthor) {
    // Zod chỉ chốt được `categoryId` đúng dạng 24 hex. Không kiểm tra ở đây thì một id hợp lệ
    // về hình thức nhưng không trỏ tới danh mục nào vẫn tạo ra tin — và tin đó rơi khỏi mọi
    // bộ lọc danh mục mà không ai biết vì sao.
    await categoryService.assertUsable(input.categoryId)

    const seller = await userRepository.findById(author.id)
    if (!seller) throw new NotFoundError('User not found')

    const visibility = input.visibility ?? POST_VISIBILITY.ORG_INTERNAL
    const provinceCode = await resolveProvinceCode(input, author, visibility)
    const sellerId = new Types.ObjectId(author.id)
    const categoryId = new Types.ObjectId(input.categoryId)

    const since = new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const recentRejections = await listingRepository.countRecentRejections(sellerId, since)

    const target = await resolveTargetOrg(input, author)

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
      autoApprove: isAutoApprove(author.trustLevel, recentRejections),
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

    const doc = toListingDoc(
      input,
      author,
      { name: seller.name, contact: seller.phone ?? '' },
      routed,
      provinceCode,
    )

    // Người ngoài ghi vào org mà họ KHÔNG thuộc về: request này không có scope org (đúng thiết
    // kế), nên đây là một lối đi xuyên tenant thật sự và phải khai bằng `runUnscoped` — tin
    // mang `organizationId` tường minh, và tổ chức đã bật `allowOutsiderPosts` để mời nó vào.
    return routed.queue === MODERATION_QUEUE.ORG_OUTSIDER
      ? runUnscoped('outsider post into org đã bật allowOutsiderPosts', () =>
          listingRepository.create(doc),
        )
      : listingRepository.create(doc)
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

  async list(query: ListingQuery) {
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

  async update(id: string, userId: string, input: UpdateListingInput) {
    await assertOwner(id, userId)
    if (input.categoryId) await categoryService.assertUsable(input.categoryId)

    const { categoryId, location, attributes, ...rest } = input
    const update: Partial<IListing> = { ...rest }
    if (categoryId) update.category = new Types.ObjectId(categoryId)
    if (location) update.location = location
    if (attributes) update.attributes = new Map(Object.entries(attributes))

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
  ) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')

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

  async removeByModerator(id: string) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')
    return listingRepository.softDelete(id)
  },

  moderationStats(trendDays: number) {
    return listingRepository.statsForModeration(trendDays)
  },
}
