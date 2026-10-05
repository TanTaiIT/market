import { Types } from 'mongoose'
import type { PushCategory } from '../../common/constants'
import { PUSH_CATEGORY } from '../../common/constants'
import { NotFoundError, ServiceUnavailableError } from '../../common/errors'
import { env } from '../../config/env'
import { logger } from '../../config/logger'
import { userRepository } from '../user/user.repository'
import { pushDispatcher } from './push.dispatcher'
import {
  PUSH_LIMITS,
  chatPushText,
  isSafePushPath,
  requiresOptIn,
  resolvePushPrefs,
} from './push.policy'
import { pushRepository } from './push.repository'
import type { RegisterPushDeviceInput, UpdatePushPreferencesInput } from './push.schema'
import { toPushDeviceDto, toPushPreferencesDto } from './push.types'

type Id = Types.ObjectId | string

/**
 * Công tắc tổng, bọc trong object để test bật được bằng `vi.spyOn` — `env` đã đóng băng giá trị
 * từ lúc import, còn test thì cần bật push cho đúng một file.
 */
export const pushConfig = {
  enabled: (): boolean => env.PUSH_ENABLED,
}

export interface PushEvent {
  category: PushCategory
  title: string
  body: string
  /** Màn app mở ra khi chạm. `null` = mở hộp thư thông báo. */
  path: string | null
  notificationId?: string | null
}

const toObjectId = (id: Id) => (typeof id === 'string' ? new Types.ObjectId(id) : id)

/**
 * Push KHÔNG BAO GIỜ được làm hỏng nghiệp vụ gọi nó: duyệt tin xong mà ghi outbox lỗi thì tin vẫn
 * phải được duyệt. Mọi đường enqueue đi qua đây — lỗi chỉ để lại một dòng log.
 */
async function safely(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    logger.error('push: enqueue failed', { label, err })
  }
}

function safePath(path: string | null): string | null {
  if (path === null || isSafePushPath(path)) return path
  logger.error('push: bỏ đường dẫn không hợp lệ', { path })
  return null
}

export const pushService = {
  // ── THIẾT BỊ & TUỲ CHỌN (API của app) ──────────────────────────────────────

  async registerDevice(userId: string, input: RegisterPushDeviceInput) {
    const device = await pushRepository.upsertDevice({
      userId,
      token: input.token,
      platform: input.platform,
      appVersion: input.appVersion ?? '',
      deviceName: input.deviceName ?? '',
    })
    await pushRepository.trimDevices(userId, PUSH_LIMITS.DEVICES_MAX)
    return toPushDeviceDto(device)
  },

  /**
   * Gỡ theo TOKEN, không cần đăng nhập — xem route. Cầm được token nghĩa là đang cầm đúng cái
   * máy đó; còn phiên thì có thể đã chết trước khi app kịp gỡ (hết hạn refresh token).
   */
  async unregisterDevice(token: string) {
    await pushRepository.removeByToken(token)
  },

  async preferences(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new NotFoundError('User not found')
    return toPushPreferencesDto(resolvePushPrefs(user.pushPrefs))
  },

  async updatePreferences(userId: string, input: UpdatePushPreferencesInput) {
    const updated = await userRepository.setPushPrefs(userId, {
      enabled: input.enabled,
      categories: Object.fromEntries(
        Object.entries(input.categories ?? {}).filter(([, v]) => v !== undefined),
      ) as Record<string, boolean>,
    })
    if (!updated) throw new NotFoundError('User not found')
    return toPushPreferencesDto(resolvePushPrefs(updated.pushPrefs))
  },

  /** Push thử tới chính mình — bỏ qua công tắc (nhóm `account`), để màn cài đặt kiểm được đường truyền. */
  async sendTest(userId: string) {
    if (!pushConfig.enabled()) {
      throw new ServiceUnavailableError('Push notification chưa bật trên server')
    }
    const devices = await pushRepository.countActiveForUser(userId)
    if (devices > 0) {
      await pushService.notify([userId], {
        category: PUSH_CATEGORY.ACCOUNT,
        title: 'Thông báo thử',
        body: 'Điện thoại này đã nhận được thông báo từ Ghim.',
        path: '/settings',
      })
    }
    return { devices }
  },

  // ── PHÁT (API cho các feature khác) ────────────────────────────────────────

  /**
   * Xếp push cho một nhóm người nhận. Không bao giờ ném — xem `safely`.
   *
   * Chỉ ghi dòng cho người CÓ máy còn nhận: nhóm 500 người mà 50 người cài app thì là 50 dòng,
   * không phải 500. Nhóm tắt-theo-mặc-định (`group_activity`) lọc thêm người đã bật ngay ở đây.
   */
  async notify(
    recipients: Id[],
    event: PushEvent,
    opts: { exceptUserId?: Id | null } = {},
  ): Promise<void> {
    if (!pushConfig.enabled() || recipients.length === 0) return
    await safely(event.category, async () => {
      const except = opts.exceptUserId?.toString()
      let ids = [...new Set(recipients.map((id) => id.toString()))]
        .filter((id) => id !== except)
        .map((id) => new Types.ObjectId(id))
      if (requiresOptIn(event.category)) {
        ids = await userRepository.optedIntoPush(ids, event.category)
      }
      ids = await pushRepository.usersWithDevices(ids)
      if (ids.length === 0) return

      const path = safePath(event.path)
      await pushRepository.enqueue(
        ids.map((userId) => ({
          userId,
          category: event.category,
          title: event.title,
          body: event.body,
          data: { path, notificationId: event.notificationId ?? null, conversationId: null },
          collapseKey: null,
        })),
      )
      pushDispatcher.kick()
    })
  },

  /**
   * Push tin nhắn chat, có GỘP: tin đầu của một hội thoại đi ngay; tin tới trong 30 giây sau đó
   * dồn vào MỘT dòng hẹn giờ cuối cửa sổ ("3 tin nhắn mới"). Mười tin gõ liền là một hai push,
   * không phải mười cái rung.
   */
  async notifyChat(input: { recipientIds: Id[]; conversationId: string; senderName: string }) {
    if (!pushConfig.enabled() || input.recipientIds.length === 0) return
    await safely(PUSH_CATEGORY.CHAT, async () => {
      const ids = await pushRepository.usersWithDevices(input.recipientIds.map(toObjectId))
      const key = `chat:${input.conversationId}`
      const path = `/chat/${input.conversationId}`
      const now = new Date()
      let delay = 0

      for (const userId of ids) {
        const first = chatPushText(input.senderName, 1)
        if (await pushRepository.coalesce(userId, key, first.title)) continue

        const recent = await pushRepository.lastSentWithKey(
          userId,
          key,
          new Date(now.getTime() - PUSH_LIMITS.CHAT_COALESCE_MS),
        )
        const at = recent
          ? new Date(recent.createdAt.getTime() + PUSH_LIMITS.CHAT_COALESCE_MS)
          : now
        delay = Math.max(delay, at.getTime() - now.getTime())
        await pushRepository.enqueue([
          {
            userId,
            category: PUSH_CATEGORY.CHAT,
            ...first,
            data: { path, notificationId: null, conversationId: input.conversationId },
            collapseKey: key,
            nextAttemptAt: at,
          },
        ])
      }
      pushDispatcher.kick()
      if (delay > 0) pushDispatcher.kick(delay)
    })
  },

  // ── VÒNG ĐỜI PHIÊN ─────────────────────────────────────────────────────────

  /**
   * Gỡ máy khi phiên bị cắt (đăng xuất mọi thiết bị, đổi mật khẩu, refresh token bị dùng lại,
   * khoá tài khoản): máy đã bị đá ra khỏi tài khoản thì không được nhận push của tài khoản đó.
   * `exceptToken` = máy vừa đổi mật khẩu, vẫn đang đăng nhập.
   */
  async revokeDevices(userId: Id, opts: { exceptToken?: string } = {}) {
    await safely('revoke', async () => {
      await pushRepository.removeAllForUser(userId, opts)
    })
  },

  /** Xoá tài khoản: máy và mọi push chưa đi. */
  async forgetUser(userId: Id) {
    await safely('forget', async () => {
      await Promise.all([
        pushRepository.removeAllForUser(userId),
        pushRepository.deletePendingForUser(userId),
      ])
    })
  },
}
