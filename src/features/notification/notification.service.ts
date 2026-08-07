import { Types } from 'mongoose'
import { notificationRepository } from './notification.repository'
import { CreateNotificationInput, NotificationQuery } from './notification.schema'
import { NOTIFICATION_SOURCE } from '../../common/constants'
import { NotFoundError } from '../../common/errors'
import { parsePagination, buildPaginationMeta } from '../../common/utils/pagination'

export const notificationService = {
  /** Thông báo cấp org: đúng một bản ghi, organizationId do tenantPlugin gán. */
  createForOrganization(input: CreateNotificationInput) {
    return notificationRepository.create({
      ...input,
      sourceType: NOTIFICATION_SOURCE.ORGANIZATION,
      sourceChainId: null,
    })
  },

  /**
   * Thông báo cấp chain: nhân bản mỗi org một bản ghi thay vì mở quyền đọc xuyên org.
   * Đổi lại N bản ghi cho N org — chấp nhận được vì Notification nhỏ hơn Listing nhiều,
   * và trạng thái đã đọc tách sạch theo org.
   */
  createForChain(
    chainId: Types.ObjectId,
    orgIds: Types.ObjectId[],
    input: CreateNotificationInput,
  ) {
    return notificationRepository.fanOut(
      orgIds.map((organizationId) => ({
        organizationId,
        sourceType: NOTIFICATION_SOURCE.CHAIN,
        sourceChainId: chainId,
        ...input,
      })),
    )
  },

  async list(query: NotificationQuery) {
    const pagination = parsePagination(query)
    const { items, total } = await notificationRepository.paginate(pagination)
    return {
      items,
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  async markRead(id: string, userId: string) {
    const notification = await notificationRepository.markRead(id, new Types.ObjectId(userId))
    if (!notification) throw new NotFoundError('Notification not found')
    return notification
  },
}
