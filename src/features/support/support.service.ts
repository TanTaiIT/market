import { Types } from 'mongoose'
import { supportRepository } from './support.repository'
import { ISupportThreadDocument, SUPPORT_SIDE } from './support.model'
import { userRepository } from '../user/user.repository'
import { bannedPhraseService } from '../banned-phrase/banned-phrase.service'
import { bannedContentReason, bannedPhraseIn } from '../moderation/moderation.machine'
import { BadRequestError, NotFoundError } from '../../common/errors'
import {
  buildPaginationMeta,
  parsePagination,
  PaginationParams,
} from '../../common/utils/pagination'
import { logger } from '../../config/logger'

const DUPLICATE_KEY = 11000

/** Trả về luồng của người này, tạo mới nếu chưa có. */
async function threadOf(userId: string): Promise<ISupportThreadDocument> {
  const existing = await supportRepository.findByUser(userId)
  if (existing) return existing

  try {
    return await supportRepository.create(new Types.ObjectId(userId))
  } catch (err) {
    /*
     * Hai thiết bị bấm gửi cùng lúc: cả hai đọc "chưa có luồng" rồi cùng tạo. Unique index để
     * đúng một bên thắng — bên thua đọc lại luồng vừa được tạo thay vì ném lỗi vào mặt người
     * dùng cho một thao tác đã thành công ở nơi khác.
     */
    if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err
    const raced = await supportRepository.findByUser(userId)
    if (!raced) throw err
    return raced
  }
}

/** Người dùng có tin chưa đọc từ master không — đây là cái chấm đỏ trên icon. */
const hasUnreadForUser = (t: ISupportThreadDocument) =>
  t.lastMasterAt !== null && (t.userReadAt === null || t.lastMasterAt > t.userReadAt)

/** Luồng đang chờ master trả lời — điều kiện của hàng đợi, giữ ở MỘT chỗ. */
const isWaitingForMaster = (t: ISupportThreadDocument) =>
  t.lastUserAt !== null && (t.masterReadAt === null || t.lastUserAt > t.masterReadAt)

export const supportService = {
  /**
   * Luồng của chính người gọi. Chưa nhắn bao giờ thì trả luồng RỖNG, không phải 404.
   *
   * Client dùng đúng một hình dạng dữ liệu cho cả hai trạng thái, nên màn hỗ trợ không cần
   * nhánh "chưa có gì" riêng — và cái chấm đỏ đọc `unread` mà không phải đoán từ mã lỗi.
   */
  async myThread(userId: string) {
    const thread = await supportRepository.findByUser(userId)
    if (!thread) {
      return { id: null, messages: [], unread: false, updatedAt: null }
    }
    return {
      id: thread._id.toString(),
      messages: thread.messages,
      unread: hasUnreadForUser(thread),
      updatedAt: thread.updatedAt,
    }
  },

  /**
   * Người dùng gửi một tin cho đội ngũ nền tảng.
   *
   * Cổng cụm từ cấm áp ở đây như mọi bề mặt nội dung khác: kênh hỗ trợ cũng là một ô nhập tự
   * do mà người lạ gõ vào được, và không có người duyệt đứng trước nó.
   */
  async send(userId: string, body: string) {
    const banned = bannedPhraseIn(body, await bannedPhraseService.phrases())
    if (banned) throw new BadRequestError(bannedContentReason(banned))

    const thread = await threadOf(userId)
    const updated = await supportRepository.appendMessage(
      thread._id,
      {
        from: SUPPORT_SIDE.USER,
        body,
        at: new Date(),
        byUserId: new Types.ObjectId(userId),
      },
      'lastUserAt',
    )
    logger.info('support: người dùng gửi tin', { userId, threadId: thread._id.toString() })
    return { id: updated!._id.toString(), messages: updated!.messages, unread: false }
  },

  /** Người dùng mở luồng ra đọc — tắt chấm đỏ. */
  async markRead(userId: string) {
    const thread = await supportRepository.findByUser(userId)
    // Chưa có luồng thì không có gì để đánh dấu, và đó KHÔNG phải lỗi: client gọi hàm này mỗi
    // lần mở popup, kể cả lần đầu tiên khi người dùng chưa nhắn gì.
    if (!thread) return { unread: false }

    await supportRepository.markRead(thread._id, 'userReadAt', new Date())
    return { unread: false }
  },

  /* ----------------------------- phía master ----------------------------- */

  /**
   * Hàng đợi hỗ trợ. `onlyWaiting` mặc định BẬT: thứ master cần là danh sách việc chưa làm,
   * không phải kho lưu trữ mọi cuộc trò chuyện từng có.
   */
  async queue(query: { waiting?: boolean } & Partial<PaginationParams>) {
    const pagination = parsePagination(query as never)
    const { items, total } = await supportRepository.paginateForMaster(
      query.waiting !== false,
      pagination,
    )

    // Tên người gửi tra một lượt cho cả trang — N+1 ở đây là N truy vấn cho một màn danh sách.
    const users = await userRepository.findByIds(items.map((t) => t.userId))
    const nameOf = new Map(users.map((u) => [u._id.toString(), u.name]))

    return {
      items: items.map((t) => ({
        id: t._id.toString(),
        userId: t.userId.toString(),
        userName: nameOf.get(t.userId.toString()) ?? 'Người dùng đã xoá',
        lastUserAt: t.lastUserAt,
        lastMasterAt: t.lastMasterAt,
        waiting: isWaitingForMaster(t),
      })),
      meta: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
    }
  },

  /** Một luồng đầy đủ cho master đọc. Mở ra là đánh dấu đã xem — nó rời hàng đợi. */
  async threadForMaster(threadId: string) {
    const thread = await supportRepository.findById(threadId)
    if (!thread) throw new NotFoundError('Không tìm thấy luồng hỗ trợ này')

    const user = await userRepository.findById(thread.userId)
    await supportRepository.markRead(thread._id, 'masterReadAt', new Date())

    return {
      id: thread._id.toString(),
      userId: thread.userId.toString(),
      userName: user?.name ?? 'Người dùng đã xoá',
      messages: thread.messages,
    }
  },

  /**
   * Master trả lời. `lastMasterAt` nhích lên là chấm đỏ hiện trên icon của đúng người đó.
   *
   * KHÔNG bắn thêm `notificationService.notifyUser`: một sự việc báo bằng hai kênh thì người
   * dùng đọc một kênh rồi kênh kia vẫn sáng, và họ học được rằng dấu hiệu ở đây không đáng
   * tin. Chấm đỏ trên icon hỗ trợ là nơi câu trả lời này thuộc về.
   */
  async reply(threadId: string, masterId: string, body: string) {
    const thread = await supportRepository.findById(threadId)
    if (!thread) throw new NotFoundError('Không tìm thấy luồng hỗ trợ này')

    const updated = await supportRepository.appendMessage(
      thread._id,
      {
        from: SUPPORT_SIDE.MASTER,
        body,
        at: new Date(),
        byUserId: new Types.ObjectId(masterId),
      },
      'lastMasterAt',
    )
    logger.info('support: master trả lời', { threadId, masterId })

    return {
      id: updated!._id.toString(),
      userId: updated!.userId.toString(),
      messages: updated!.messages,
    }
  },

  /** Số luồng đang chờ — badge cho mục menu của master. */
  waitingCount() {
    return supportRepository.countWaiting()
  },
}
