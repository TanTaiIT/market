import { Types } from 'mongoose'
import { notificationRepository } from './notification.repository'
import type { NotificationAudience } from './notification.repository'
import { CreateNotificationInput, NotificationQuery } from './notification.schema'
import { toNotificationDto } from './notification.types'
import { canModerateOrg } from '../../common/authz/policy'
import { SCOPE_TYPES } from '../../common/constants'
import type { Grant } from '../../common/authz/policy'
import type { OrgActor } from '../../common/utils/actor'
import { membershipRepository } from '../membership/membership.repository'
import { orgUnitRepository } from '../org-unit/org-unit.repository'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

/** Người đọc hộp thư. `organizationId: null` = không thuộc tổ chức nào, chỉ có tin đích danh. */
type Viewer = { id: string; organizationId: string | null; grants: Grant[] }

/**
 * Nhóm mà người này ĐỨNG TRONG — quyết định họ nhận được thông báo nào. Kèm `recipientId` để
 * hộp thư có cả tin đích danh; `managedAudience` cố tình KHÔNG có, vì bàn quản trị liệt kê thứ
 * mình gửi được chứ không phải hộp thư riêng của người khác.
 */
async function inboxAudience(viewer: Viewer): Promise<NotificationAudience> {
  const recipientId = new Types.ObjectId(viewer.id)
  if (!viewer.organizationId) return { organizationId: null, recipientId }

  const membership = await membershipRepository.findActive(viewer.id, viewer.organizationId)
  return {
    organizationId: new Types.ObjectId(viewer.organizationId),
    units: membership?.unitId ? [membership.unitId] : [],
    recipientId,
  }
}

/**
 * Nhóm mà người này GỬI TỚI ĐƯỢC.
 *
 * Ai gửi được cho cả tổ chức thì cũng đọc được mọi thông báo của tổ chức — `all: true` bỏ hẳn
 * điều kiện nhóm. Còn staff nhóm con chỉ thấy phần trong tầm với của họ, đúng bằng thứ họ gửi
 * được, nên bàn quản trị không thành đường vòng đọc thông báo của nhóm khác.
 */
async function managedAudience(viewer: Viewer): Promise<NotificationAudience> {
  const { organizationId } = viewer
  // Bàn quản trị luôn đi kèm một org — `requireOrgModerator` ở route đã chốt.
  if (!organizationId) return { organizationId: null, units: [] }
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
    const audience =
      query.scope === 'managed' ? await managedAudience(viewer) : await inboxAudience(viewer)

    const pagination = parsePagination(query)
    const { items, total } = await notificationRepository.paginate(audience, pagination)

    return {
      items: items.map((doc) => toNotificationDto(doc, viewer.id)),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
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

  async markRead(id: string, userId: string) {
    const notification = await notificationRepository.markRead(id, new Types.ObjectId(userId))
    if (!notification) throw new NotFoundError('Notification not found')
    return toNotificationDto(notification, userId)
  },
}
