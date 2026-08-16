import { Types } from 'mongoose'
import { organizationRepository } from './organization.repository'
import { toMyOrganizationDto, toOrganizationLookupDto } from './organization.types'
import { CreateOrganizationInput } from './organization.schema'
import { userRepository } from '../user/user.repository'
import { membershipRepository } from '../membership/membership.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import {
  JOINED_VIA,
  MEMBERSHIP_ROLES,
  ORG_CAPABILITY_PRESETS,
  ORG_TYPES,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  TenantStatus,
} from '../../common/constants'
import { ConflictError, NotFoundError } from '../../common/errors'
import { isReservedSlug, suggestOrgSlugs, toOrgSlug } from '../../common/utils/orgSlug'
import { logger } from '../../config/logger'

/** Trần dropdown: đủ để chọn, không đủ để dùng API này liệt kê danh sách khách hàng. */
const LOOKUP_LIMIT = 10

/** Lý do slug bị từ chối — client hiển thị thông điệp tương ứng, không tự đoán theo chuỗi. */
export const SLUG_REJECTION = {
  INVALID: 'invalid',
  RESERVED: 'reserved',
  TAKEN: 'taken',
} as const

export interface SlugHints {
  district?: string | null
  provinceCode?: string | null
}

export const organizationService = {
  /**
   * Tạo org — CHỈ master (quyết định Q2). Không có luồng tự phục vụ.
   *
   * Ba việc phải xảy ra cùng nhau, nếu không org sinh ra trong trạng thái không dùng được:
   * bản ghi org, quan hệ thành viên `owner`, và quyền `manager` scope org cho người chủ. Thiếu
   * cái thứ ba thì chủ org không duyệt được gì trong chính org của mình.
   */
  async createByMaster(actorId: string, input: CreateOrganizationInput) {
    const slug = toOrgSlug(input.slug ?? input.name)
    const availability = await this.checkSlugAvailability(slug, {
      district: input.district,
      provinceCode: input.provinceCode,
    })
    if (!availability.available) {
      // Gợi ý đi kèm lỗi chứ không bắt gọi thêm một vòng: người đang đứng ở form cần biết ngay
      // dùng được cái gì, không phải chỉ biết mình vừa sai.
      throw new ConflictError(
        `Slug "${slug}" không dùng được: ${availability.reason}`,
        (availability.suggestions ?? []).map((suggestion) => ({
          path: 'slug',
          message: suggestion,
        })),
      )
    }

    const owner = await userRepository.findByEmail(input.ownerEmail)
    if (!owner) {
      throw new NotFoundError(
        `Chưa có tài khoản nào dùng email ${input.ownerEmail} — người chủ phải đăng ký trước`,
      )
    }

    const orgId = new Types.ObjectId()
    const orgType = input.orgType ?? ORG_TYPES.GENERIC

    const [org] = await organizationRepository.create({
      _id: orgId,
      name: input.name,
      slug,
      orgType,
      // Preset chọn một lần lúc tạo; từ đây trở đi code đọc `capabilities`, không đọc `orgType`
      // — nếu không thì "tổng quát hoá" chỉ là thêm một cột.
      capabilities: ORG_CAPABILITY_PRESETS[orgType],
      provinceCode: input.provinceCode ?? null,
      district: input.district ?? null,
      ownerId: owner._id,
      createdBy: new Types.ObjectId(actorId),
    })

    await membershipRepository.create({
      userId: owner._id,
      organizationId: orgId,
      role: MEMBERSHIP_ROLES.OWNER,
      joinedVia: JOINED_VIA.ROSTER,
    })

    await roleGrantRepository.create({
      userId: owner._id,
      role: SYSTEM_ROLES.MANAGER,
      scopeType: SCOPE_TYPES.ORG,
      orgId,
      grantedBy: new Types.ObjectId(actorId),
    })

    logger.info('organization created', { actorId, orgId: orgId.toString(), slug })
    return org
  },

  async getById(id: string) {
    const org = await organizationRepository.findById(id)
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },

  /**
   * Các tổ chức mà người này đang là thành viên.
   *
   * Client cần nó để dựng bộ chuyển tổ chức: từ v2, org hoạt động do client chỉ ra qua header
   * `X-Org-Slug`, nên nếu không có danh sách này thì người thuộc nhiều org không có cách nào
   * biết mình được phép gửi những slug nào. Trả kèm `role`/`unitId` vì màn hình cần phân biệt
   * chủ tổ chức với thành viên thường mà không phải gọi thêm một vòng.
   */
  async listMine(userId: string) {
    const memberships = await membershipRepository.listActiveByUser(userId)

    const rows = await Promise.all(
      memberships.map(async (m) => {
        const org = await organizationRepository.findById(m.organizationId)
        return org ? { org, membership: m } : null
      }),
    )

    // Org đã bị xoá mềm thì bỏ khỏi danh sách thay vì trả một dòng rỗng: người dùng không chọn
    // được nó, hiện ra chỉ để họ bấm vào rồi ăn lỗi.
    return rows.filter((row) => row !== null).map(toMyOrganizationDto)
  },

  /**
   * Dropdown chọn org. KHÔNG bao giờ tự lấy kết quả đầu tiên khi có nhiều kết quả — rủi ro lớn
   * nhất không phải "không tìm thấy" mà là "tìm thấy nhầm mà không ai biết", tin lặng lẽ chạy
   * vào hàng đợi org khác (§6.2). Vì vậy hàm này chỉ trả danh sách, việc chọn là của người dùng.
   */
  async lookup(query: string, limit = LOOKUP_LIMIT) {
    const orgs = await organizationRepository.search(query, limit)
    return orgs.map(toOrganizationLookupDto)
  },

  /**
   * Kiểm tra lúc TẠO org: chỉ trả available/không + gợi ý, KHÔNG trả tên org đang giữ slug đó.
   * Đây là API công khai, trả tên là biến nó thành công cụ liệt kê danh sách khách hàng (§6.4).
   */
  async checkSlugAvailability(rawSlug: string, hints: SlugHints = {}) {
    const slug = toOrgSlug(rawSlug)

    if (!slug) return { slug, available: false, reason: SLUG_REJECTION.INVALID }
    if (isReservedSlug(slug)) {
      return { slug, available: false, reason: SLUG_REJECTION.RESERVED }
    }
    if (await organizationRepository.existsBySlugNormalized(slug)) {
      return {
        slug,
        available: false,
        reason: SLUG_REJECTION.TAKEN,
        suggestions: await this.availableSuggestions(slug, hints),
      }
    }
    return { slug, available: true }
  },

  async availableSuggestions(slug: string, hints: SlugHints) {
    const candidates = suggestOrgSlugs(slug, hints)
    const free: string[] = []
    for (const candidate of candidates) {
      if (isReservedSlug(candidate)) continue
      if (!(await organizationRepository.existsBySlugNormalized(candidate))) free.push(candidate)
    }
    return free
  },

  /**
   * Đổi slug: slug cũ trở thành alias để URL đã phát ra ngoài redirect 301 thay vì chết.
   * `orgId` mới là khoá ngoại ở mọi nơi, slug chỉ là lookup key — nên đổi slug không đụng một
   * bản ghi nghiệp vụ nào.
   */
  async changeSlug(organizationId: string, rawSlug: string) {
    const org = await this.getById(organizationId)
    const slug = toOrgSlug(rawSlug)
    if (slug === org.slug) return org

    const availability = await this.checkSlugAvailability(slug)
    if (!availability.available) {
      throw new ConflictError(`Slug "${slug}" không dùng được: ${availability.reason}`)
    }

    const previousSlug = org.slug
    const updated = await organizationRepository.updateById(organizationId, { slug })
    if (!updated) throw new NotFoundError('Organization not found')

    await organizationRepository.createAlias(previousSlug, updated._id)
    return updated
  },

  async setStatus(organizationId: string, status: TenantStatus) {
    const org = await organizationRepository.updateById(organizationId, { status })
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },
}
