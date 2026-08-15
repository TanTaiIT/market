import { Types } from 'mongoose'
import { listingRepository } from './listing.repository'
import { CreateListingInput, UpdateListingInput, ListingQuery, NearbyQuery } from './listing.schema'
import { IListing } from './listing.model'
import { userRepository } from '../user/user.repository'
import { categoryService } from '../category/category.service'
import { NotFoundError, ForbiddenError } from '../../common/errors'
import { LISTING_STATUS, ListingStatus } from '../../common/constants'
import { slugifyWithSuffix } from '../../common/utils/slugify'
import {
  parsePagination,
  buildPaginationMeta,
  PaginationParams,
} from '../../common/utils/pagination'

const LISTING_TTL_DAYS = 30

export interface ListingAuthor {
  id: string
  organizationId: string
}

function toListingDoc(
  input: CreateListingInput,
  author: ListingAuthor,
  poster: { name: string; contact: string },
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
    status: LISTING_STATUS.PENDING,
    expiresAt,
  }
}

async function assertOwner(id: string, userId: string) {
  const listing = await listingRepository.findById(id)
  // Tin của org ngoài chain đã bị scope loại từ tầng plugin -> null -> 404, không lộ tồn tại.
  if (!listing) throw new NotFoundError('Listing not found')
  if (listing.seller.toString() !== userId) {
    throw new ForbiddenError('You can only modify your own listing')
  }
  return listing
}

export const listingService = {
  async create(input: CreateListingInput, author: ListingAuthor) {
    // Zod chỉ chốt được `categoryId` đúng dạng 24 hex. Không kiểm tra ở đây thì một id hợp lệ
    // về hình thức nhưng không trỏ tới danh mục nào vẫn tạo ra tin — và tin đó rơi khỏi mọi
    // bộ lọc danh mục mà không ai biết vì sao.
    await categoryService.assertUsable(input.categoryId)

    const seller = await userRepository.findById(author.id, author.organizationId)
    if (!seller) throw new NotFoundError('User not found')

    return listingRepository.create(
      toListingDoc(input, author, { name: seller.name, contact: seller.phone ?? '' }),
    )
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

  async removeByModerator(id: string) {
    const listing = await listingRepository.findById(id)
    if (!listing) throw new NotFoundError('Listing not found')
    return listingRepository.softDelete(id)
  },

  moderationStats(trendDays: number) {
    return listingRepository.statsForModeration(trendDays)
  },
}
