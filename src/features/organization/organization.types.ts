import { Types } from 'mongoose'
import { IOrganizationDocument } from './organization.model'
import { OrganizationSummaryDto, OrganizationLookupDto } from './organization.schema'

export function toOrganizationDto(org: IOrganizationDocument): OrganizationSummaryDto {
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    orgType: org.orgType,
    verificationTier: org.verificationTier,
    provinceCode: org.provinceCode,
    status: org.status,
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
    provinceCode: row.org.provinceCode,
    role: row.membership.role,
    unitId: row.membership.unitId?.toString() ?? null,
  }
}

/**
 * Dòng trong dropdown chọn org. PHẢI đủ để phân biệt hai org trùng tên bằng mắt — "THPT Lý
 * Thường Kiệt — Quận Tân Bình, TP.HCM" chứ không phải mỗi cái tên (§6.2). Cố tình không mang
 * `id`: người dùng chọn bằng slug, và API này là công khai.
 */
export function toOrganizationLookupDto(org: IOrganizationDocument): OrganizationLookupDto {
  return {
    name: org.name,
    slug: org.slug,
    district: org.district,
    provinceCode: org.provinceCode,
    allowJoinRequests: org.allowJoinRequests,
    allowOutsiderPosts: org.allowOutsiderPosts,
  }
}
