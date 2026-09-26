import { Types } from 'mongoose'
import { clearOrganizationCache, organizationRepository } from './organization.repository'
import { listingRepository } from '../listing/listing.repository'
import {
  toMyOrganizationDto,
  toOrganizationDto,
  toOrganizationLookupDto,
  toOrganizationProfileDto,
} from './organization.types'
import {
  CreateOrganizationInput,
  OrganizationAdminQuery,
  UpdateOrganizationInput,
} from './organization.schema'
import { userRepository } from '../user/user.repository'
import { membershipRepository } from '../membership/membership.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
// Chốt một-người-một-trục. Nhập từ service chứ không chép lại luật: hai bản sao của một luật
// phân quyền là hai bản sẽ lệch nhau ở lần sửa kế tiếp.
import { assertSingleAxis, roleGrantService } from '../role-grant/role-grant.service'
import { canGrant } from '../../common/authz/policy'
import {
  ORG_CAPABILITY_PRESETS,
  ORG_TYPES,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  TENANT_STATUS,
  TenantStatus,
} from '../../common/constants'
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import { orgNameTokens } from '../../common/utils/orgName'
import { generateJoinCode, normalizeJoinCode } from '../../common/utils/joinCode'
import { requireOwnOrgId } from '../../common/tenant/tenantContext'
import { notificationService } from '../notification/notification.service'
import { buildPaginationMeta, parsePagination } from '../../common/utils/pagination'
import { logger } from '../../config/logger'

/** Mã lỗi unique index của MongoDB. */
const DUPLICATE_KEY = 11000

/**
 * Số lần sinh lại khi mã nhóm đụng nhau. 31^6 ≈ 887 triệu tổ hợp nên đụng là chuyện hiếm —
 * nhưng "hiếm" không phải "không", và một lần đụng không xử lý là một org tạo hụt.
 */
const JOIN_CODE_ATTEMPTS = 5

/**
 * Sinh mã và ghi, để unique index làm trọng tài.
 *
 * Không "tra xem mã đã tồn tại chưa rồi mới ghi": giữa hai câu lệnh đó là đúng khe mà hai lượt
 * tạo org song song lọt qua và cùng nhận một mã.
 */
async function withUniqueJoinCode<T>(write: (joinCode: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < JOIN_CODE_ATTEMPTS; attempt += 1) {
    try {
      return await write(generateJoinCode())
    } catch (err) {
      const duplicate = err as { code?: number; keyPattern?: Record<string, unknown> }
      // CHỈ thử lại khi chính mã nhóm đụng: một lỗi 11000 của index khác sẽ đụng lại y hệt ở cả
      // 5 lượt, rồi bị báo thành "không sinh được mã nhóm" — sai nguyên nhân.
      if (duplicate.code !== DUPLICATE_KEY || !duplicate.keyPattern?.joinCode) throw err
    }
  }
  throw new ConflictError('Không sinh được mã nhóm, thử lại giúp')
}

/** Trần dropdown: đủ để chọn, không đủ để dùng API này liệt kê danh sách khách hàng. */
const LOOKUP_LIMIT = 10

/** Mốc 7 ngày cho `postsThisWeek` — tính lúc gọi, không phải hằng số dựng sẵn lúc nạp module. */
const WEEK_AGO = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

export const organizationService = {
  /**
   * Tạo org — CHỈ master (quyết định Q2). Không có luồng tự phục vụ.
   *
   * Ba việc phải xảy ra cùng nhau, nếu không org sinh ra trong trạng thái không dùng được:
   * bản ghi org, quan hệ thành viên `owner`, và quyền `manager` scope org cho người chủ. Thiếu
   * cái thứ ba thì chủ org không duyệt được gì trong chính org của mình.
   */
  async createByMaster(actorId: string, input: CreateOrganizationInput) {
    const orgId = new Types.ObjectId()
    const orgType = input.orgType ?? ORG_TYPES.GENERIC

    const [org] = await withUniqueJoinCode((joinCode) =>
      organizationRepository.create({
        _id: orgId,
        joinCode,
        name: input.name,
        orgType,
        // Preset chọn một lần lúc tạo; từ đây trở đi code đọc `capabilities`, không đọc `orgType`
        // — nếu không thì "tổng quát hoá" chỉ là thêm một cột.
        capabilities: ORG_CAPABILITY_PRESETS[orgType],
        provinceCode: input.provinceCode ?? null,
        district: input.district ?? null,
        createdBy: new Types.ObjectId(actorId),
        // Sinh ra không có người phụ trách. `findActiveById` chỉ thấy org `active`, nên tới khi
        // master trao quyền thì org này chưa tồn tại với phần còn lại của hệ thống.
        status: TENANT_STATUS.PENDING_ADMIN,
      }),
    )

    logger.info('organization created', { actorId, orgId: orgId.toString() })
    return org
  },

  /**
   * Trao quyền phụ trách một org cho một tài khoản.
   *
   * Tách khỏi `create` vì hai việc này có nhịp khác nhau: master dựng org theo danh sách,
   * còn người phụ trách thì tìm được lúc nào trao lúc đó. Gộp vào một lượt như bản cũ nghĩa là
   * không tạo nổi org khi chưa biết ai sẽ trông nó.
   *
   * Hai thứ được ghi cùng nhau và không tách rời được về mặt nghiệp vụ: `Membership` là thân
   * phận (hiện trong danh bạ), `RoleGrant` mới là quyền thật (mở bàn duyệt). Thiếu cái sau thì
   * "admin" chỉ là một cái nhãn không mở được gì.
   *
   * Gọi lại với cùng một người là thao tác VÔ HẠI: cả hai bước đều tự nhận ra đã có.
   */
  /**
   * Ai đang phụ trách nhóm này — cho bảng tổ chức của master.
   *
   * Đi từ GRANT ra người, không từ danh bạ vào: grant là nơi giữ quyền thật (xem
   * `orgManagerSchema`). Hệ quả là một grant trỏ tới tài khoản đã xoá vẫn hiện thành một
   * dòng, chỉ thiếu tên — cố ý: `userRepository.findByIds` tự loại user xoá mềm, nên lọc
   * theo kết quả của nó sẽ làm dòng đó biến mất khỏi màn này TRONG KHI vẫn được tính là
   * 'nhóm có manager' ở bàn tổng quan. Hai chỗ lệch nhau là thứ không ai lần ra được.
   */
  async managers(organizationId: string) {
    const org = await organizationRepository.findById(organizationId)
    if (!org) throw new NotFoundError('Organization not found')

    const grants = await roleGrantRepository.listActiveOrgManagerGrants(org._id)
    if (grants.length === 0) return []

    const users = await userRepository.findByIds(grants.map((g) => g.userId))
    const byId = new Map(users.map((u) => [u._id.toString(), u]))

    return grants.map((grant) => {
      const user = byId.get(grant.userId.toString())
      return {
        grantId: grant._id.toString(),
        userId: grant.userId.toString(),
        name: user?.name ?? null,
        email: user?.email ?? null,
        avatar: user?.avatar ?? null,
        grantedAt: grant.createdAt.toISOString(),
      }
    })
  },

  async grantAdmin(organizationId: string, email: string, actorId: string) {
    const org = await organizationRepository.findById(organizationId)
    if (!org) throw new NotFoundError('Organization not found')

    const user = await userRepository.findByEmail(email)
    if (!user) {
      throw new NotFoundError(
        `Chưa có tài khoản nào dùng email ${email} — người phụ trách phải đăng ký trước`,
      )
    }

    /*
     * Chặn TRƯỚC khi đụng vào membership, không phải trước khi tạo grant.
     *
     * Khối ngay dưới nâng người này lên `MEMBERSHIP_ROLES.ADMIN` của nhóm. Đặt chốt sau đó thì
     * một lượt bị từ chối vẫn kịp đổi vai thành viên rồi mới ném — để lại đúng trạng thái nửa
     * vời mà không ai dọn: admin trong danh bạ nhóm nhưng không có quyền duyệt nào.
     */
    /*
     * Cùng luật với `POST /role-grants` (`canGrant`): không ai tự cấp cho mình, kể cả master —
     * vết cấp quyền luôn có hai người. Route đã `requireMaster`, nên chốt này thực tế chỉ còn
     * chặn đúng ca tự cấp; bản trước bỏ qua nó và đây là đường duy nhất master tự trao được.
     */
    const actorGrants = await roleGrantService.grantsOf(actorId)
    const target = {
      userId: user._id.toString(),
      grant: { role: SYSTEM_ROLES.MANAGER, scopeType: SCOPE_TYPES.ORG, orgId: org._id.toString() },
    }
    if (!canGrant({ userId: actorId, grants: actorGrants }, target)) {
      throw new ForbiddenError(
        'Không đủ thẩm quyền để trao quyền quản trị — và không ai tự trao cho mình',
      )
    }

    await assertSingleAxis(user._id, SCOPE_TYPES.ORG)

    // Một đường cho thân phận admin, dùng chung với `POST /role-grants` scope org.
    await membershipRepository.ensureAdmin(user._id, org._id)

    try {
      await roleGrantRepository.create({
        userId: user._id,
        role: SYSTEM_ROLES.MANAGER,
        scopeType: SCOPE_TYPES.ORG,
        orgId: org._id,
        grantedBy: new Types.ObjectId(actorId),
      })
    } catch (err) {
      // Unique index chặn cấp trùng một quyền còn hiệu lực. Trao lại cho người đã có quyền là
      // thao tác lặp, không phải lỗi — nuốt đúng mã đó, mọi lỗi khác vẫn nổi lên.
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err
    }

    // Org đầu tiên có người phụ trách thì mở cửa. Lần trao thứ hai trở đi không đụng gì.
    if (org.status === TENANT_STATUS.PENDING_ADMIN) {
      org.status = TENANT_STATUS.ACTIVE
      await org.save()
      clearOrganizationCache()
    }

    // Người được trao không có mặt lúc master bấm nút, và không màn hình nào tự bật lên báo họ.
    await notificationService.notifyUser({
      organizationId: org._id,
      userId: user._id,
      title: 'Bạn được giao phụ trách một tổ chức',
      body: `Bạn giờ là quản trị của "${org.name}".`,
    })

    logger.info('organization admin granted', {
      actorId,
      orgId: org._id.toString(),
      userId: user._id.toString(),
    })
    return org
  },

  /**
   * Hồ sơ nhóm, do admin của chính org sửa.
   *
   * Org lấy từ TENANT SCOPE chứ không từ đường dẫn: `requireOrgAdmin` đã đối chiếu quyền trên
   * đúng org đang hoạt động, nhận thêm một id ở path là mở ra cửa thứ hai để hai nguồn lệch nhau.
   *
   * `nameTokens` dựng lại khi đổi tên: nó là khoá tra của dropdown chọn org, quên cập nhật thì
   * org đổi tên xong biến mất khỏi ô tìm kiếm mà không ai hiểu vì sao.
   */
  async update(input: UpdateOrganizationInput) {
    const orgId = requireOwnOrgId('organization.update')
    const org = await organizationRepository.findById(orgId.toString())
    if (!org) throw new NotFoundError('Organization not found')

    if (input.name !== undefined) {
      org.name = input.name
      org.nameTokens = orgNameTokens(input.name)
    }
    if (input.description !== undefined) org.description = input.description
    if (input.avatarUrl !== undefined) org.avatarUrl = input.avatarUrl
    if (input.coverUrl !== undefined) org.coverUrl = input.coverUrl
    if (input.allowJoinRequests !== undefined) org.allowJoinRequests = input.allowJoinRequests
    if (input.allowOutsiderPosts !== undefined) org.allowOutsiderPosts = input.allowOutsiderPosts
    if (input.rules !== undefined) org.rules = input.rules
    if (input.feedLayout !== undefined) org.feedLayout = input.feedLayout

    await org.save()
    return org
  },

  /**
   * Xoay mã nhóm. Mã cũ chết ngay lập tức — đó là toàn bộ lý do tính năng này tồn tại: mã lọt
   * ra ngoài thì phải có đường cắt, mà `_id` của org (định danh trong mọi link) thì không đổi được.
   */
  async rotateJoinCode() {
    const orgId = requireOwnOrgId('organization.rotateJoinCode')
    const org = await organizationRepository.findById(orgId.toString())
    if (!org) throw new NotFoundError('Organization not found')

    return withUniqueJoinCode(async (joinCode) => {
      org.joinCode = joinCode
      return org.save()
    })
  },

  /** Thẻ nhóm cho người cầm mã: đủ để họ nhận ra đúng nhóm trước khi bấm xin vào. */
  async getByJoinCode(rawCode: string) {
    // Chuẩn hoá y hệt đường xin gia nhập. Thiếu một chỗ là cùng một chuỗi dán vào cho ra hai
    // kết quả khác nhau: xem thẻ thì 404, bấm xin vào thì được.
    const org = await organizationRepository.findActiveByJoinCode(normalizeJoinCode(rawCode))
    if (!org) throw new NotFoundError('Không tìm thấy nhóm nào với mã này')

    const memberCount = await membershipRepository.countActiveByOrganization(org._id)
    return { org, memberCount }
  },

  /**
   * Các tổ chức mà người này đang là thành viên.
   *
   * Client cần nó để dựng bộ chuyển tổ chức: từ v2, org hoạt động do client chỉ ra qua header
   * `X-Org-Id`, nên nếu không có danh sách này thì người thuộc nhiều org không có cách nào
   * biết mình được phép gửi những id nào. Trả kèm `role`/`unitId` vì màn hình cần phân biệt
   * chủ tổ chức với thành viên thường mà không phải gọi thêm một vòng.
   */
  async listMine(userId: string) {
    const memberships = await membershipRepository.listActiveByUser(userId)

    // Nạp một lượt rồi ghép trong bộ nhớ: bản cũ bắn một truy vấn CHO MỖI org người dùng
    // thuộc về, và đây là đường chạy mỗi lần mở app.
    const orgs = await organizationRepository.findByIds(memberships.map((m) => m.organizationId))
    const byId = new Map(orgs.map((org) => [org._id.toString(), org]))

    // Org đã bị xoá mềm thì vắng khỏi `byId` và bị bỏ khỏi danh sách, thay vì trả một dòng
    // rỗng: người dùng không chọn được nó, hiện ra chỉ để họ bấm vào rồi ăn lỗi.
    return memberships
      .map((membership) => {
        const org = byId.get(membership.organizationId.toString())
        return org ? { org, membership } : null
      })
      .filter((row) => row !== null)
      .map(toMyOrganizationDto)
  },

  /**
   * Bảng tổ chức TOÀN hệ thống — chỉ master gọi được.
   *
   * Tồn tại vì `listMine` luôn rỗng với master: quyền của họ là grant `master/system`, không
   * phải membership, nên họ cố ý không thuộc org nào. Mà bộ chuyển tổ chức của client lại đọc
   * `listMine` để biết được phép gửi `X-Org-Id` nào — kết quả là master không chọn được org
   * nào và mọi màn org-scoped trả 403 dù họ có thừa quyền vào (`canModerateAnyInOrg` cho master
   * đi thẳng). Đây là nguồn lấp chỗ đó.
   *
   * KHÔNG gộp vào `lookup`: route đó công khai và chỉ trả nhóm `isPublic` đang hoạt động —
   * không phải bảng master cần, nơi org đang khoá mới là thứ họ phải xử lý.
   */
  async listAll(query: OrganizationAdminQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await organizationRepository.paginateAll(
      { q: query.q, status: query.status },
      pagination,
    )
    return {
      items: items.map(toOrganizationDto),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Danh sách nhóm cho màn khám phá — kết quả tìm, và khi từ khoá rỗng là khối "Gợi ý cho bạn".
   *
   * CHỈ nhóm công khai (`searchPublic`). Nhóm riêng tư không lộ ra ở đây, kể cả khi gõ đúng tên:
   * cách duy nhất vào nhóm riêng tư vẫn là cầm mã, y như trước.
   *
   * Đếm thành viên theo LÔ chứ không từng nhóm một — mười dòng kết quả mà đếm lẻ là mười lượt
   * truy vấn nữa trên đúng đường người dùng đang gõ.
   */
  async discover(query: string, limit = LOOKUP_LIMIT) {
    /*
     * Gõ đúng MỘT MÃ thì trả đúng nhóm đó — kể cả nhóm RIÊNG TƯ.
     *
     * Không phải lỗ hổng: cầm được mã vốn đã là điều kiện vào nhóm kín, và `GET
     * /organizations/by-code` đã cho tra đúng như vậy từ trước, sau cùng một `lookupLimiter`.
     * Khác biệt duy nhất là người dùng không phải đoán mình đang cầm tên hay cầm mã — một ô
     * nhập, hai loại dữ liệu, đúng như dòng gợi ý trên màn hình hứa.
     *
     * Tra theo mã TRƯỚC và trả ngay: lẫn nó vào kết quả tìm tên là người vừa dán mã phải đi
     * tìm nhóm mình trong một danh sách.
     */
    const byCode = await organizationRepository.findActiveByJoinCode(normalizeJoinCode(query))
    if (byCode) {
      const count = await membershipRepository.countActiveByOrganization(byCode._id)
      return [toOrganizationLookupDto(byCode, count)]
    }

    const orgs = await organizationRepository.searchPublic(query, limit)
    const counts = await membershipRepository.countActiveByOrganizations(orgs.map((o) => o._id))
    return orgs.map((org) => toOrganizationLookupDto(org, counts.get(org._id.toString()) ?? 0))
  },

  /**
   * Hồ sơ nhóm, đọc theo id — thứ người dùng xem TRƯỚC khi bấm xin vào.
   *
   * BA cửa vào, và chỉ ba: nhóm công khai; thành viên của chính nhóm đó; hoặc người đưa đúng
   * `code` của nhóm đó. Cửa thứ ba là chìa khoá chứ không phải ngoại lệ — cầm mã đã là điều
   * kiện vào nhóm kín, nên bắt người ta gửi đơn vào một nơi chưa từng nhìn thấy là một bước
   * thừa, không phải một lớp bảo vệ.
   *
   * MỌI ca hỏng đều trả 404, không bao giờ 403: 403 xác nhận "có nhóm ở id này, chỉ là không
   * cho xem" — đủ để quét id ra danh sách nhóm kín, và với `code` sai thì đủ để biến endpoint
   * thành máy dò mã cho một id đã biết. Chống brute-force là việc của `lookupLimiter` trên route.
   *
   * Cửa mã mở HỒ SƠ, không mở NỘI DUNG: tin của nhóm kín đều ở bậc `members`, và
   * `listingPublicPredicate` vẫn cắt chúng khỏi người không phải thành viên. Người cầm mã đọc
   * được nhóm là ai, không đọc được nhóm đang bán gì.
   */
  async publicProfile(id: string, viewerId: string | null, code?: string) {
    const org = await organizationRepository.findAliveById(id)
    if (!org) throw new NotFoundError('Không tìm thấy nhóm này')

    const [memberCount, postsThisWeek, membership] = await Promise.all([
      membershipRepository.countActiveByOrganization(org._id),
      listingRepository.countCreatedSinceForOrg(org._id, WEEK_AGO()),
      viewerId ? membershipRepository.findActive(viewerId, org._id) : Promise.resolve(null),
    ])

    /*
     * Nhóm RIÊNG TƯ chỉ thành viên mới xem được hồ sơ. Lọc ở repository thì chính quản trị
     * nhóm cũng nhận 404 trên nhóm họ đang quản — nên chốt phải nằm ở đây, chỗ biết được
     * người đang xem là ai.
     *
     * Vẫn 404 chứ không 403: 403 xác nhận "có nhóm ở id này", đủ để quét ra danh sách nhóm kín.
     */
    const holdsCode = Boolean(code) && normalizeJoinCode(code!) === org.joinCode
    if (org.isPublic === false && !membership && !holdsCode) {
      throw new NotFoundError('Không tìm thấy nhóm này')
    }

    return toOrganizationProfileDto(org, {
      memberCount,
      postsThisWeek,
      joined: Boolean(membership),
    })
  },

  /**
   * Công khai ↔ riêng tư — quyền MASTER, xem `setOrgVisibilitySchema`.
   *
   * Chuyển sang riêng tư có hiệu lực NGAY và có hậu quả thật: nhóm rơi khỏi tìm kiếm, hồ sơ
   * trả 404 cho mọi người ngoài, và mọi link đã phát ra ngoài chết theo. Đường vào duy nhất
   * còn lại là mã tham gia.
   */
  async setVisibility(organizationId: string, isPublic: boolean) {
    /*
     * HẠ BẬC TRƯỚC, gạt cờ SAU. Thứ tự này là chốt an toàn, không phải thói quen.
     *
     * Bậc `group_open` chỉ hợp lệ dưới một nhóm công khai, và luật đó phải đúng ở CẢ HAI mép:
     * mép tạo nằm ở `routeListing`, mép này là mép còn lại.
     *
     * Đứt gánh giữa chừng theo thứ tự này để lại "nhóm còn công khai, vài tin đã kín" — thiếu
     * lộ, chạy lại là xong, người dùng chỉ thấy hụt vài tin. Thứ tự ngược lại để lại "nhóm đã
     * kín, tin vẫn đọc công khai" — đúng thứ luật này sinh ra để cấm. Bất biến cần nhớ: KHÔNG
     * BAO GIỜ để một tin `group_open` nằm dưới một nhóm riêng tư, kể cả trong chốc lát.
     *
     * Cân nhắc và bỏ qua transaction: `withTransaction` có sẵn (test chạy replica set) nhưng
     * riêng thứ tự đã cho ca hỏng an toàn, và nó rẻ hơn.
     */
    if (!isPublic) await listingRepository.demoteGroupOpen(new Types.ObjectId(organizationId))

    const org = await organizationRepository.updateById(organizationId, { isPublic })
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },

  async setStatus(organizationId: string, status: TenantStatus) {
    const org = await organizationRepository.updateById(organizationId, { status })
    if (!org) throw new NotFoundError('Organization not found')
    return org
  },
}
