import { Types } from 'mongoose'
import { joinRequestRepository } from './join-request.repository'
import { IJoinRequestDocument } from './join-request.model'
import { toJoinRequestDto, toMyJoinRequestDto } from './join-request.types'
import { CreateJoinRequestInput } from './join-request.schema'
import { organizationRepository } from '../organization/organization.repository'
import { normalizeJoinCode } from '../../common/utils/joinCode'
import { membershipRepository } from '../membership/membership.repository'
import { orgUnitRepository } from '../org-unit/org-unit.repository'
import { notificationService } from '../notification/notification.service'
import {
  JOIN_REQUEST_LIMITS,
  JOIN_REQUEST_STATUS,
  JOINED_VIA,
  MEMBERSHIP_ROLES,
} from '../../common/constants'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS)
}

export const joinRequestService = {
  /**
   * Gửi đơn xin vào org. Người gửi CHƯA thuộc org nào nên hàm này không dùng tenant scope —
   * org đến từ slug người dùng đã xác nhận trên dropdown.
   */
  async create(actorId: string, input: CreateJoinRequestInput) {
    /*
     * `findPublicBySlug` chứ không `findActiveBySlug`: đường slug CHỈ mở cho nhóm công khai.
     * Dùng bản không lọc `isPublic` ở đây là mở lại đúng bề mặt spam mà cái mã sinh ra để
     * chặn — ai đoán ra slug của một nhóm kín cũng gửi được đơn vào đó.
     */
    const full = input.code
      ? await organizationRepository.findActiveByJoinCode(normalizeJoinCode(input.code))
      : await organizationRepository.findPublicBySlug(input.slug!)
    if (!full) {
      throw new NotFoundError(
        input.code ? 'Không tìm thấy nhóm nào với mã này' : 'Không tìm thấy nhóm công khai này',
      )
    }
    const org = { _id: full._id }

    if (!full.allowJoinRequests) {
      throw new ForbiddenError('Tổ chức này đang không nhận đơn tham gia')
    }

    if (await membershipRepository.findActive(actorId, org._id)) {
      throw new ConflictError('Bạn đã là thành viên của tổ chức này')
    }

    const now = new Date()
    await joinRequestRepository.expireStale(now)

    // Trần số đơn đang chờ: một người rải đơn khắp nơi là cách rẻ nhất để làm ngập hàng đợi
    // của nhiều org cùng lúc (§7.5).
    if (
      (await joinRequestRepository.countPendingByUser(actorId)) >=
      JOIN_REQUEST_LIMITS.MAX_PENDING_PER_USER
    ) {
      throw new ConflictError(
        `Bạn đang có ${JOIN_REQUEST_LIMITS.MAX_PENDING_PER_USER} đơn chờ duyệt — xử lý xong rồi gửi tiếp`,
      )
    }

    const rejected = await joinRequestRepository.latestRejected(actorId, org._id)
    if (rejected?.reviewedAt) {
      const until = addDays(rejected.reviewedAt, JOIN_REQUEST_LIMITS.REJECT_COOLDOWN_DAYS)
      if (until > now) {
        throw new ConflictError(
          `Đơn trước bị từ chối, gửi lại được sau ${until.toISOString().slice(0, 10)}`,
        )
      }
    }

    try {
      const doc = await joinRequestRepository.create({
        userId: new Types.ObjectId(actorId),
        organizationId: org._id,
        claimedName: input.claimedName,
        claimedUnit: input.claimedUnit ?? null,
        note: input.note ?? null,
        expiresAt: addDays(now, JOIN_REQUEST_LIMITS.EXPIRES_IN_DAYS),
      })
      return toMyJoinRequestDto(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError('Bạn đã gửi đơn cho tổ chức này và đang chờ duyệt')
      }
      throw err
    }
  },

  async listMine(actorId: string) {
    const docs = await joinRequestRepository.listByUser(actorId)
    return docs.map(toMyJoinRequestDto)
  },

  async cancel(actorId: string, requestId: string) {
    const doc = await this.getPending(requestId)
    if (doc.userId.toString() !== actorId) throw new ForbiddenError('Không phải đơn của bạn')

    const updated = await joinRequestRepository.updateById(requestId, {
      status: JOIN_REQUEST_STATUS.CANCELLED,
      reviewedAt: new Date(),
    })
    return toMyJoinRequestDto(updated!)
  },

  /** Hàng đợi duyệt của org hoạt động. */
  async listForOrganization(organizationId: Types.ObjectId, status?: string) {
    await joinRequestRepository.expireStale(new Date())
    const docs = await joinRequestRepository.listByOrganization(organizationId, status)
    return docs.map(toJoinRequestDto)
  },

  /**
   * Duyệt đơn = tạo membership. `unitId` gán NGAY TẠI ĐÂY chứ không tách thành bước riêng:
   * cơ chế request không tự phân nhóm được như mã mời/roster, nên nếu tách bước thì sẽ không
   * ai làm, và lớp duyệt phân tầng mất chỗ dựa (§7.2a).
   */
  async approve(
    actorId: string,
    organizationId: Types.ObjectId,
    requestId: string,
    unitId?: string | null,
  ) {
    const doc = await this.getPending(requestId)
    if (!doc.organizationId.equals(organizationId)) {
      throw new NotFoundError('Đơn không thuộc tổ chức này')
    }
    if (doc.expiresAt < new Date()) throw new ConflictError('Đơn đã hết hiệu lực')

    if (unitId) {
      const unit = await orgUnitRepository.findById(unitId)
      if (!unit) throw new BadRequestError('Nhóm con không tồn tại trong tổ chức này')
    }

    // Tạo membership TRƯỚC rồi mới đánh dấu đơn: đứt gánh giữa chừng theo thứ tự này để lại
    // "đã là thành viên, đơn vẫn chờ" (duyệt lại là xong), còn thứ tự ngược lại để lại "đơn đã
    // duyệt nhưng không có membership" — người dùng bị kẹt và không ai nhìn ra.
    const existing = await membershipRepository.findActive(doc.userId, organizationId)
    if (!existing) {
      await membershipRepository.create({
        userId: doc.userId,
        organizationId,
        role: MEMBERSHIP_ROLES.MEMBER,
        unitId: unitId ? new Types.ObjectId(unitId) : null,
        joinedVia: JOINED_VIA.REQUEST,
      })
    }

    const updated = await joinRequestRepository.updateById(requestId, {
      status: JOIN_REQUEST_STATUS.APPROVED,
      reviewedBy: new Types.ObjectId(actorId),
      reviewedAt: new Date(),
    })

    // Người gửi đơn không có mặt lúc duyệt, và không có màn hình nào tự bật lên báo họ. Trước
    // khi `Notification` có người nhận đích danh thì tin này không có chỗ nào để đáp.
    await notificationService.notifyUser({
      organizationId,
      userId: doc.userId,
      title: 'Đơn xin vào tổ chức đã được duyệt',
      body: 'Bạn đã là thành viên. Mở lại ứng dụng và chọn tổ chức này để bắt đầu.',
    })

    return toJoinRequestDto(updated!)
  },

  async reject(
    actorId: string,
    organizationId: Types.ObjectId,
    requestId: string,
    reason?: string,
  ) {
    const doc = await this.getPending(requestId)
    if (!doc.organizationId.equals(organizationId)) {
      throw new NotFoundError('Đơn không thuộc tổ chức này')
    }

    const updated = await joinRequestRepository.updateById(requestId, {
      status: JOIN_REQUEST_STATUS.REJECTED,
      reviewedBy: new Types.ObjectId(actorId),
      reviewedAt: new Date(),
      rejectReason: reason ?? null,
    })

    // Lý do đi KÈM thông báo: nó vốn chỉ nằm trong `rejectReason` của bản ghi đơn, mà người bị
    // từ chối thì không còn màn hình nào trong org đó để mở ra đọc.
    await notificationService.notifyUser({
      organizationId,
      userId: doc.userId,
      title: 'Đơn xin vào tổ chức bị từ chối',
      body: reason ?? 'Quản trị tổ chức không nêu lý do.',
    })

    return toJoinRequestDto(updated!)
  },

  /**
   * Duyệt hàng loạt. Không có màn hình này thì hai điểm yếu cố hữu của cơ chế "duyệt tay" trở
   * thành lỗi chí mạng: org vài trăm người, toàn bộ lượt join dồn vào 1-2 tuần đầu năm (§7.3).
   *
   * Từng đơn hỏng KHÔNG làm hỏng cả lô — trả về kết quả từng dòng để người duyệt biết cái nào
   * cần xem lại, thay vì rollback im lặng cả lô.
   */
  async bulkApprove(
    actorId: string,
    organizationId: Types.ObjectId,
    items: { id: string; unitId?: string | null }[],
  ) {
    const results = []
    for (const item of items) {
      try {
        await this.approve(actorId, organizationId, item.id, item.unitId)
        results.push({ id: item.id, ok: true as const })
      } catch (err) {
        results.push({ id: item.id, ok: false as const, error: (err as Error).message })
      }
    }
    return {
      approved: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    }
  },

  async getPending(requestId: string): Promise<IJoinRequestDocument> {
    const doc = await joinRequestRepository.findById(requestId)
    if (!doc) throw new NotFoundError('Không tìm thấy đơn')
    if (doc.status !== JOIN_REQUEST_STATUS.PENDING) {
      throw new ConflictError(`Đơn đã ở trạng thái "${doc.status}"`)
    }
    return doc
  },
}
