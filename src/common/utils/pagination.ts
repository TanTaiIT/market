import { PAGINATION } from '../constants'

export interface PaginationParams {
  page: number
  limit: number
  skip: number
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNextPage: boolean
  hasPrevPage: boolean
}

/**
 * Chuẩn hoá tham số phân trang từ query string.
 */
export function parsePagination(query: { page?: unknown; limit?: unknown } = {}): PaginationParams {
  let page = Number(query.page) || PAGINATION.DEFAULT_PAGE
  let limit = Number(query.limit) || PAGINATION.DEFAULT_LIMIT

  if (page < 1) page = PAGINATION.DEFAULT_PAGE
  if (limit < 1) limit = PAGINATION.DEFAULT_LIMIT
  if (limit > PAGINATION.MAX_LIMIT) limit = PAGINATION.MAX_LIMIT

  return { page, limit, skip: (page - 1) * limit }
}

export function buildPaginationMeta(args: {
  page: number
  limit: number
  total: number
}): PaginationMeta {
  const { page, limit, total } = args
  const totalPages = Math.ceil(total / limit) || 0
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  }
}
