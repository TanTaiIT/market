import { Types } from 'mongoose'
import { IOrganizationDocument } from './organization.model'
import {
  OrganizationSummaryDto,
  OrganizationLookupDto,
  OrganizationProfileDto,
} from './organization.schema'

export function toOrganizationDto(org: IOrganizationDocument): OrganizationSummaryDto {
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    joinCode: org.joinCode,
    avatarUrl: org.avatarUrl,
    description: org.description,
    orgType: org.orgType,
    verificationTier: org.verificationTier,
    provinceCode: org.provinceCode,
    status: org.status,
    // Thiếu field = nhóm tạo trước khi `isPublic` ra đời, và mặc định của nó là công khai —
    // cùng lập luận với `PUBLIC = { isPublic: { $ne: false } }` bên repository.
    isPublic: org.isPublic !== false,
  }
}

/**
 * Thẻ nhóm hiện cho người vừa nhập mã, TRƯỚC khi họ bấm xin vào.
 *
 * Không mang `id`, `slug` lẫn `joinCode`: endpoint này công khai, ai dò trúng một mã cũng đọc
 * được — cho họ đúng thứ cần để nhận ra nhóm, không thêm gì để lần ra org bằng đường khác.
 */
export function toOrganizationCardDto(org: IOrganizationDocument, memberCount: number) {
  return {
    name: org.name,
    avatarUrl: org.avatarUrl,
    description: org.description,
    provinceCode: org.provinceCode,
    district: org.district,
    memberCount,
    allowJoinRequests: org.allowJoinRequests,
  }
}

/** Một tổ chức mà người đang đăng nhập thuộc về — nguồn của bộ chuyển tổ chức phía client. */
export function toMyOrganizationDto(row: {
  org: IOrganizationDocument
  membership: { role: string; unitId: Types.ObjectId | null }
}) {
  return {
    id: row.org._id.toString(),
    name: row.org.name,
    slug: row.org.slug,
    avatarUrl: row.org.avatarUrl,
    provinceCode: row.org.provinceCode,
    role: row.membership.role,
    unitId: row.membership.unitId?.toString() ?? null,
    feedLayout: row.org.feedLayout,
  }
}

/**
 * Một dòng trong danh sách nhóm. PHẢI đủ để phân biệt hai nhóm trùng tên bằng mắt — "THPT Lý
 * Thường Kiệt — Quận Tân Bình, TP.HCM" chứ không phải mỗi cái tên (§6.2). Cố tình không mang
 * `id`: người dùng đi tiếp bằng slug, và API này là công khai.
 *
 * `memberCount` do người gọi đếm theo lô rồi truyền vào — đếm từng nhóm một ở đây là N+1
 * ngay giữa đường tìm kiếm.
 */
export function toOrganizationLookupDto(
  org: IOrganizationDocument,
  memberCount: number,
): OrganizationLookupDto {
  return {
    name: org.name,
    slug: org.slug,
    joinCode: org.joinCode,
    avatarUrl: org.avatarUrl,
    memberCount,
    district: org.district,
    provinceCode: org.provinceCode,
    allowJoinRequests: org.allowJoinRequests,
    allowOutsiderPosts: org.allowOutsiderPosts,
  }
}

/**
 * Hồ sơ nhóm công khai. `joined` và hai con số đếm đến từ NGOÀI document: chúng thuộc về
 * người đang xem và về dữ liệu ở collection khác, không phải thuộc tính của tổ chức.
 */
export function toOrganizationProfileDto(
  org: IOrganizationDocument,
  extra: { memberCount: number; postsThisWeek: number; joined: boolean },
): OrganizationProfileDto {
  return {
    name: org.name,
    slug: org.slug,
    joinCode: org.joinCode,
    avatarUrl: org.avatarUrl,
    coverUrl: org.coverUrl,
    description: org.description,
    provinceCode: org.provinceCode,
    district: org.district,
    rules: org.rules,
    allowOutsiderPosts: org.allowOutsiderPosts,
    feedLayout: org.feedLayout,
    allowJoinRequests: org.allowJoinRequests,
    ...extra,
  }
}
