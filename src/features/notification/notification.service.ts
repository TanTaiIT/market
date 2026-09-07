import { Types } from 'mongoose'
import { notificationRepository } from './notification.repository'
import type { ManagedAudience } from './notification.repository'
import { CreateNotificationInput, NotificationQuery } from './notification.schema'
import { toNotificationDto } from './notification.types'
import { canModerateOrg } from '../../common/authz/policy'
import { POST_VISIBILITY, SCOPE_TYPES } from '../../common/constants'
import type { PostVisibility } from '../../common/constants'
import type { Grant } from '../../common/authz/policy'
import type { OrgActor } from '../../common/utils/actor'
import { membershipRepository } from '../membership/membership.repository'
import { orgUnitRepository } from '../org-unit/org-unit.repository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

/** Người đọc hộp thư. `organizationId` chỉ còn dùng cho `scope=managed` (bàn quản trị). */
type Viewer = { id: string; organizationId: string | null; grants: Grant[] }

/*
 * Hộp thư đọc từ MỌI nhóm người ta tham gia — xem `list` bên dưới, nơi nó được dựng.
 *
 * Bản trước có một hàm `inboxAudience(viewer)` đọc `viewer.organizationId`, tức org của
 * request. Hai hệ quả đều sai: người thuộc ba nhóm chỉ thấy thông báo của một nhóm, và người
 * không có org đang thao tác (ai thuộc từ HAI nhóm trở lên, vì bộ chuyển tổ chức chỉ dành cho
 * master) không thấy nhánh phát chung nào cả. Hộp thư là của con người, không phải của một
 * phiên làm việc trong một nhóm.
 *
 * Không tách thành hàm riêng nữa: `list` cần chính danh sách `memberships` đó hai lần — một
 * lần dựng phạm vi đọc, một lần lấy mốc `notificationsSeenAt` của từng nhóm. Tách ra là đọc
 * `memberships` hai lượt cho cùng một câu hỏi.
 */

/**
 * Nhóm mà người này GỬI TỚI ĐƯỢC.
 *
 * Ai gửi được cho cả tổ chức thì cũng đọc được mọi thông báo của tổ chức — `all: true` bỏ hẳn
 * điều kiện nhóm. Còn staff nhóm con chỉ thấy phần trong tầm với của họ, đúng bằng thứ họ gửi
 * được, nên bàn quản trị không thành đường vòng đọc thông báo của nhóm khác.
 */
async function managedAudience(viewer: Viewer): Promise<ManagedAudience | null> {
  const { organizationId } = viewer
  if (!organizationId) return null

  const orgObjectId = new Types.ObjectId(organizationId)
  if (canModerateOrg(viewer.grants, { orgId: organizationId, unitId: null })) {
    return { organizationId: orgObjectId, all: true }
  }

  const units = viewer.grants
    .filter(
      (g) =>
        g.scopeType === SCOPE_TYPES.ORG_UNIT && g.orgId?.toString() === organizationId && g.unitId,
    )
    .map((g) => new Types.ObjectId(g.unitId!.toString()))

  /*
   * KHÔNG phụ trách gì trong org này → không quản lý dòng thông báo nào. `null`, chứ không phải
   * `units: []`.
   *
   * Đây là một lỗ hổng đọc thật, và nó KHÔNG đi qua `memberships`. `units: []` khiến
   * `managedFilter` trả về `{ organizationId, userId: null, unitId: null }` — tức TOÀN BỘ thông
   * báo phát chung của tổ chức. Cộng với việc `resolveTenant` cố ý mở scope đọc của một org cho
   * người NGOÀI nhóm khi request là `GET` (để họ xem được trang công khai của nhóm), một người
   * lạ chỉ cần gửi `X-Org-Slug` của nhóm rồi thêm `?scope=managed` là đọc được cả dòng thông
   * báo nội bộ: thông báo của quản trị, và từ nay cả "ai vừa đăng tin gì".
   *
   * Route `GET /notifications` cố tình KHÔNG có `requireOrgModerator` — nó phục vụ cả
   * `scope=inbox` mà mọi người dùng đều gọi. Nên chốt phải nằm đúng ở đây.
   */
  if (units.length === 0) return null

  return { organizationId: orgObjectId, units }
}

export const notificationService = {
  /**
   * Gửi thông báo. `unitId` rỗng = cả tổ chức.
   *
   * `requireOrgModerator` ở tầng route chỉ trả lời "có duyệt được thứ gì đó trong org này
   * không" — cố tình rộng, để staff của một nhóm mở được màn hình của họ. Phạm vi thật phải
   * chốt ở đây bằng `canModerateOrg`, nếu không staff nhóm con gửi được cho toàn tổ chức,
   * rộng hơn hẳn thứ họ được cấp.
   */
  async createForOrganization(
    input: CreateNotificationInput,
    actor: OrgActor & { grants: Grant[] },
  ) {
    const unitId = input.unitId ?? null

    if (!canModerateOrg(actor.grants, { orgId: actor.organizationId, unitId })) {
      throw new ForbiddenError(
        unitId
          ? 'Bạn không phụ trách nhóm này'
          : 'Chỉ người quản lý cấp tổ chức mới gửi được cho cả tổ chức',
      )
    }

    if (unitId) {
      const unit = await orgUnitRepository.findById(unitId)
      if (!unit) throw new BadRequestError('Nhóm con không tồn tại trong tổ chức này')
    }

    // `organizationId` khai TƯỜNG MINH: trước đây `tenantPlugin` tự điền lúc save, giờ model đã
    // ra khỏi plugin nên thiếu dòng này là thông báo phát chung không thuộc org nào và không ai
    // đọc được nó.
    return notificationRepository.create({
      organizationId: new Types.ObjectId(actor.organizationId),
      title: input.title,
      body: input.body,
      unitId: unitId ? new Types.ObjectId(unitId) : null,
    })
  },

  /**
   * `scope: 'inbox'` (mặc định) — thứ người gọi NHẬN được: gửi cho cả org, cộng nhóm của họ.
   * `scope: 'managed'` — thứ người gọi có quyền GỬI tới, dùng cho bàn quản trị.
   *
   * Lọc ở tầng query chứ không tải hết rồi cắt — cắt sau phân trang sẽ cho ra những trang
   * lưng chừng, có trang đầy có trang gần rỗng, mà tổng số thì luôn sai.
   */
  async list(query: NotificationQuery, viewer: Viewer) {
    const pagination = parsePagination(query)

    if (query.scope === 'managed') {
      const audience = await managedAudience(viewer)
      // Không quản lý dòng nào thì trả trang RỖNG, không phải 403: `scope` là tham số của một
      // route ai cũng gọi được, và 403 ở đây sẽ làm màn thông báo thường vỡ nếu client gõ nhầm.
      if (!audience) {
        return {
          items: [],
          meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total: 0 }),
        }
      }

      const { items, total } = await notificationRepository.paginateManaged(audience, pagination)
      return {
        // Bàn quản trị đọc thông báo do NGƯỜI soạn, nên `readBy` vẫn là nguồn của `isRead` —
        // không có mốc nhóm nào ở đây, và cũng không cần: nó chỉ vài dòng mỗi tháng.
        items: items.map((doc) => toNotificationDto(doc, { id: viewer.id, seenAt: new Map() })),
        meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
      }
    }

    const memberships = await membershipRepository.listActiveByUser(viewer.id)
    const { items, total } = await notificationRepository.paginateInbox(
      {
        recipientId: new Types.ObjectId(viewer.id),
        groups: memberships.map((m) => ({
          organizationId: m.organizationId,
          unitId: m.unitId,
          joinedAt: m.joinedAt,
        })),
      },
      pagination,
    )

    /*
     * Mốc "đã xem tới đâu" của TỪNG nhóm, để `toNotificationDto` chấm trạng thái đọc của dòng
     * sinh tự động. Map thay vì một mốc chung: mở hộp thư ở nhóm A không được xoá dấu chưa-đọc
     * của nhóm B.
     */
    const seenAt = new Map(
      memberships.map((m) => [m.organizationId.toString(), m.notificationsSeenAt]),
    )

    return {
      items: items.map((doc) => toNotificationDto(doc, { id: viewer.id, seenAt })),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /**
   * Báo cho CẢ NHÓM rằng một thành viên vừa có tin lên bảng.
   *
   * MỘT document cho mỗi tin, không phải một document cho mỗi thành viên: nhóm 500 người, 10
   * tin/ngày là 5.000 dòng/ngày nếu fan-out — khoảng 84 MB/tháng cho một nhóm trên cluster
   * 512 MB. Phát chung thì con số đó là 0,17 MB, và `actorId` lo phần "đừng báo cho chính người
   * vừa đăng" mà fan-out vốn dùng để đổi lấy cái giá kia.
   *
   * Gọi lúc tin THÀNH `active`, không phải lúc tạo: tin `pending` chưa ai xem được, báo sớm là
   * mời cả nhóm bấm vào một trang 404.
   *
   * Chốt là `visibility`, KHÔNG phải `organizationId` — và đây là chỗ tôi làm sai trước khi
   * test bắt được. Tin CÔNG KHAI do một thành viên đăng vẫn giữ `organizationId`, nhưng chỉ để
   * attribution (badge "đăng bởi nhóm X" — xem `listing.routing.ts`); nó nằm trên trục danh mục
   * chứ không nằm trên bảng tin của nhóm. Lọc theo org thì cả nhóm bị báo về những tin không
   * hề xuất hiện trong nhóm mình.
   */
  async notifyGroupOfListing(listing: {
    _id: Types.ObjectId
    organizationId: Types.ObjectId | null
    visibility: PostVisibility
    seller: Types.ObjectId
    posterName: string
    title: string
  }) {
    if (listing.visibility !== POST_VISIBILITY.ORG_INTERNAL) return null
    // Tin nội bộ luôn có org, nhưng kiểu vẫn cho `null` — hỏi tường minh thay vì `!`.
    if (!listing.organizationId) return null

    return notificationRepository.create({
      organizationId: listing.organizationId,
      // Phát chung cho CẢ nhóm, không bó vào nhóm con của người đăng: bảng tin là của cả nhóm,
      // `unitId` chỉ phân tầng quyền DUYỆT chứ không phân tầng quyền xem.
      userId: null,
      unitId: null,
      actorId: listing.seller,
      actorName: listing.posterName,
      listingId: listing._id,
      title: `${listing.posterName} vừa đăng một tin mới`,
      body: listing.title,
    })
  },

  /**
   * Thông báo do HỆ THỐNG sinh, gửi cho đúng một người. Không có endpoint nào gọi tới: nó là
   * hệ quả của một thao tác ở feature khác (duyệt tin, duyệt đơn), nên caller là service.
   *
   * `organizationId` phải là org của ĐỐI TƯỢNG, không phải của người thao tác — xem
   * `notificationRepository.createForUser`. Tin trục danh mục (`organizationId: null`) chưa gửi
   * được: `Notification` là collection có tenant, cùng khoản nợ với `AuditLog` dual-axis.
   */
  /**
   * Thông báo đích danh. `organizationId: null` là HỢP LỆ — việc xảy ra trên trục danh mục
   * không thuộc tổ chức nào.
   *
   * Bản trước `return null` ở đúng ca đó, và đó là lý do toàn bộ trục công khai im lặng: tin
   * được duyệt, tin bị từ chối, không một dòng nào tới tay người đăng.
   */
  async notifyUser(input: {
    organizationId: Types.ObjectId | null
    userId: Types.ObjectId
    title: string
    body: string
  }) {
    return notificationRepository.createForUser(input)
  },

  /**
   * Đánh dấu đã đọc. Hai cơ chế, chọn theo `actorId` — xem `readBy` trong `notification.model.ts`.
   *
   * Dòng SINH TỰ ĐỘNG không ghi vào `readBy` mà đẩy mốc `notificationsSeenAt` của nhóm lên tới
   * `createdAt` của nó. Hệ quả có chủ ý: bấm vào dòng mới nhất đánh dấu luôn mọi dòng cũ hơn
   * TRONG NHÓM ĐÓ là đã đọc. Đúng với cách người ta thật sự dùng hộp thư — "tôi đã xem qua rồi"
   * — và là điều kiện để `readBy` không phình theo số thành viên.
   */
  async markRead(id: string, userId: string) {
    const viewerId = new Types.ObjectId(userId)
    const existing = await notificationRepository.findById(id)
    if (!existing) throw new NotFoundError('Notification not found')

    if (existing.actorId && existing.organizationId) {
      await membershipRepository.markNotificationsSeen(
        viewerId,
        existing.organizationId,
        existing.createdAt,
      )
      // Đọc lại mốc vừa ghi thay vì tự dựng: người bấm có thể KHÔNG còn là thành viên nhóm đó
      // (vừa rời nhóm), lúc ấy `updateOne` không khớp gì và mốc phải giữ nguyên `null`.
      const membership = await membershipRepository.findActive(userId, existing.organizationId)
      return toNotificationDto(existing, {
        id: userId,
        seenAt: new Map([
          [existing.organizationId.toString(), membership?.notificationsSeenAt ?? null],
        ]),
      })
    }

    const notification = await notificationRepository.markRead(id, viewerId)
    if (!notification) throw new NotFoundError('Notification not found')
    return toNotificationDto(notification, { id: userId, seenAt: new Map() })
  },
}
