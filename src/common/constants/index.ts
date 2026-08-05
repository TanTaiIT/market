export { httpStatus } from './httpStatus'
export type { HttpStatus } from './httpStatus'

export const ROLES = {
  USER: 'user',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
} as const
export type Role = (typeof ROLES)[keyof typeof ROLES]

// Vòng đời tin đăng - tính trước để không phải migrate về sau
export const LISTING_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  ACTIVE: 'active',
  SOLD: 'sold',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  HIDDEN: 'hidden',
} as const
export type ListingStatus = (typeof LISTING_STATUS)[keyof typeof LISTING_STATUS]

export const LISTING_CONDITION = {
  NEW: 'new',
  LIKE_NEW: 'like_new',
  USED: 'used',
} as const
export type ListingCondition = (typeof LISTING_CONDITION)[keyof typeof LISTING_CONDITION]

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const
