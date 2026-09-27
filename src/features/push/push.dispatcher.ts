import { Types } from 'mongoose'
import { PUSH_OUTBOX_STATUS } from '../../common/constants'
import { env } from '../../config/env'
import { logger } from '../../config/logger'
import { reportJobError } from '../../config/sentry'
import { userRepository } from '../user/user.repository'
import { expoPushClient } from './push.client'
import type { IPushOutboxDocument, IPushTicket } from './push.model'
import {
  PUSH_LIMITS,
  buildExpoMessage,
  isCredentialError,
  isPushAllowed,
  isRetryableExpoError,
  nextAttemptAt,
  resolvePushPrefs,
  type ExpoMessage,
} from './push.policy'
import { pushRepository } from './push.repository'

/**
 * Gửi dòng `push_outbox` tới Expo — xem §3.2 của docs/architecture/push-notification.plan.md.
 *
 * Hai đường gọi vào: `kick()` ngay sau khi enqueue (đường nóng, vài trăm ms) và job Agenda mỗi
 * phút (lưới an toàn: dòng chờ retry, dòng kẹt do process chết giữa chừng). Mọi luật "có được
 * gửi không" kiểm Ở ĐÂY, ngay trước khi gửi — tắt công tắc lúc 10:00:00 thì dòng tạo lúc
 * 09:59:59 cũng không đi.
 */

const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered'
/** Expo giữ receipt 24 giờ — quá mốc đó mà chưa có thì sẽ không bao giờ có. */
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60 * 1000

export interface DispatchSummary {
  claimed: number
  sent: number
  skipped: number
  retried: number
  failed: number
}

interface Job {
  row: IPushOutboxDocument
  deviceId: Types.ObjectId
  token: string
  message: ExpoMessage
}

let running = false
let rerun = false

async function finishRow(
  row: IPushOutboxDocument,
  tickets: IPushTicket[],
  transportError: string | null,
  now: Date,
  summary: DispatchSummary,
): Promise<void> {
  // Tới được ÍT NHẤT một máy là đã gửi: máy còn lại lỗi thì receipt/ticket đã ghi lý do.
  if (tickets.some((t) => t.ticketId)) {
    await pushRepository.markSent(row._id, tickets, now)
    summary.sent += 1
    return
  }

  const codes = transportError ? [undefined] : tickets.map((t) => t.error ?? undefined)
  const reason = transportError ?? codes.join(', ')
  if (codes.some(isCredentialError)) {
    // Sai credential FCM/APNs trên EAS: retry không tự chữa được — phải có người xem ngay.
    reportJobError(new Error(`push credentials: ${reason}`), 'push:dispatch')
  }

  const retryAt = codes.some(isRetryableExpoError) ? nextAttemptAt(row.attempts + 1, now) : null
  if (retryAt) {
    await pushRepository.markRetry(row._id, retryAt, reason)
    summary.retried += 1
    return
  }
  await pushRepository.markDone(row._id, PUSH_OUTBOX_STATUS.FAILED, reason, tickets)
  summary.failed += 1
}

export const pushDispatcher = {
  /**
   * Đánh thức dispatcher. No-op trong test: test gọi thẳng `dispatchOnce()` để khẳng định từng
   * bước, còn timer chạy ngầm thì bắn request ra mạng thật giữa lúc một test khác đang chạy.
   */
  kick(delayMs = 0): void {
    if (env.isTest) return
    const timer = setTimeout(() => void pushDispatcher.drain(), delayMs)
    timer.unref?.()
  },

  /** Vét tới khi hết dòng tới hạn. Một vòng tại một thời điểm trong process; kick giữa chừng thì vét thêm lượt nữa. */
  async drain(): Promise<void> {
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      do {
        rerun = false
        while ((await pushDispatcher.dispatchOnce()).claimed === PUSH_LIMITS.DISPATCH_BATCH) {
          // lô đầy → còn dòng tới hạn, vét tiếp
        }
      } while (rerun)
    } catch (err) {
      logger.error('push: dispatch failed', { err })
    } finally {
      running = false
    }
  },

  async dispatchOnce(now: Date = new Date()): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 }
    const rows = await pushRepository.claimDue(now, PUSH_LIMITS.DISPATCH_BATCH)
    summary.claimed = rows.length
    if (rows.length === 0) return summary

    const userIds = [...new Set(rows.map((r) => r.userId.toString()))].map(
      (id) => new Types.ObjectId(id),
    )
    const [audience, devices] = await Promise.all([
      userRepository.pushAudience(userIds),
      pushRepository.activeDevicesOf(userIds),
    ])
    const users = new Map(audience.map((u) => [u._id.toString(), u]))
    const devicesOf = new Map<string, { _id: Types.ObjectId; token: string }[]>()
    for (const d of devices) {
      const key = d.userId.toString()
      devicesOf.set(key, [...(devicesOf.get(key) ?? []), { _id: d._id, token: d.token }])
    }

    const jobs: Job[] = []
    for (const row of rows) {
      const key = row.userId.toString()
      const user = users.get(key)
      // Xoá mềm thì `pushAudience` không trả về (plugin soft-delete) — cùng nhánh với bị khoá.
      const skip = !user?.isActive
        ? 'user_inactive'
        : !isPushAllowed(resolvePushPrefs(user.pushPrefs), row.category)
          ? 'pref_off'
          : !devicesOf.get(key)?.length
            ? 'no_device'
            : null
      if (skip) {
        await pushRepository.markDone(row._id, PUSH_OUTBOX_STATUS.SKIPPED, skip)
        summary.skipped += 1
        continue
      }
      for (const device of devicesOf.get(key)!) {
        jobs.push({
          row,
          deviceId: device._id,
          token: device.token,
          message: buildExpoMessage(row, device.token),
        })
      }
    }

    const tickets = new Map<string, IPushTicket[]>()
    const transport = new Map<string, string>()
    const dead: string[] = []

    for (let i = 0; i < jobs.length; i += PUSH_LIMITS.SEND_BATCH) {
      const chunk = jobs.slice(i, i + PUSH_LIMITS.SEND_BATCH)
      const res = await expoPushClient.send(chunk.map((j) => j.message))
      if (!res.ok) {
        for (const j of chunk) transport.set(j.row._id.toString(), res.message)
        logger.warn('push: expo send failed', { messages: chunk.length, error: res.message })
        continue
      }
      chunk.forEach((j, index) => {
        const t = res.value[index]
        const error =
          t === undefined
            ? 'MissingTicket'
            : t.status === 'error'
              ? (t.details?.error ?? 'Unknown')
              : null
        if (error === DEVICE_NOT_REGISTERED) dead.push(j.token)
        if (error === 'MessageTooBig') {
          logger.error('push: message too big — builder bỏ sót giới hạn độ dài', {
            outboxId: j.row._id.toString(),
            category: j.row.category,
          })
        }
        const key = j.row._id.toString()
        tickets.set(key, [
          ...(tickets.get(key) ?? []),
          {
            deviceId: j.deviceId,
            token: j.token,
            ticketId: t?.status === 'ok' ? t.id : null,
            error,
            receiptChecked: false,
          },
        ])
      })
    }

    const done = new Set<string>()
    for (const j of jobs) {
      const key = j.row._id.toString()
      if (done.has(key)) continue
      done.add(key)
      await finishRow(j.row, tickets.get(key) ?? [], transport.get(key) ?? null, now, summary)
    }

    await pushRepository.disableTokens(dead)
    if (summary.claimed > 0)
      logger.info('push: dispatched', { ...summary, deadDevices: dead.length })
    return summary
  },

  /**
   * Đọc receipt của các lô đã gửi. Ticket `ok` chỉ nghĩa là Expo NHẬN tin; việc FCM/APNs có giao
   * được không nằm ở receipt — và đó là nơi duy nhất biết máy đã gỡ app (`DeviceNotRegistered`).
   */
  async checkReceipts(now: Date = new Date()): Promise<{ checked: number; dead: number }> {
    const rows = await pushRepository.dueReceipts(now, PUSH_LIMITS.RECEIPT_BATCH)
    const ids = rows.flatMap((r) =>
      r.tickets.filter((t) => t.ticketId && !t.receiptChecked).map((t) => t.ticketId!),
    )
    if (ids.length === 0) {
      for (const row of rows) await pushRepository.saveReceipts(row._id, row.tickets, null)
      return { checked: 0, dead: 0 }
    }

    const receipts: Record<string, { status: string; details?: { error?: string } }> = {}
    for (let i = 0; i < ids.length; i += PUSH_LIMITS.RECEIPT_BATCH) {
      const res = await expoPushClient.receipts(ids.slice(i, i + PUSH_LIMITS.RECEIPT_BATCH))
      // Hỏng thì để nguyên `receiptsDueAt`: lượt quét sau hỏi lại, receipt còn giữ 24 giờ.
      if (!res.ok) {
        logger.warn('push: expo receipts failed', { error: res.message })
        return { checked: 0, dead: 0 }
      }
      Object.assign(receipts, res.value)
    }

    const dead: string[] = []
    for (const row of rows) {
      const tickets = row.tickets.map((t) => {
        if (!t.ticketId || t.receiptChecked) return t
        const receipt = receipts[t.ticketId]
        if (!receipt) return t
        const error = receipt.status === 'error' ? (receipt.details?.error ?? 'Unknown') : null
        if (error === DEVICE_NOT_REGISTERED) dead.push(t.token)
        if (isCredentialError(error ?? undefined)) {
          reportJobError(new Error(`push credentials (receipt): ${error}`), 'push:receipts')
        }
        return { ...t, error: error ?? t.error, receiptChecked: true }
      })
      const pending = tickets.some((t) => t.ticketId && !t.receiptChecked)
      const givenUp = !row.sentAt || now.getTime() - row.sentAt.getTime() > RECEIPT_GIVE_UP_MS
      const dueAt =
        pending && !givenUp ? new Date(now.getTime() + PUSH_LIMITS.RECEIPT_DELAY_MS) : null
      await pushRepository.saveReceipts(row._id, tickets, dueAt)
    }
    await pushRepository.disableTokens(dead)
    return { checked: ids.length, dead: dead.length }
  },

  /** Job `push:receipts`: đọc receipt rồi dọn máy chết / lâu không mở app. */
  async receiptsSweep(now: Date = new Date()) {
    const receipts = await pushDispatcher.checkReceipts(now)
    const pruned = await pushRepository.pruneDevices(now)
    return { ...receipts, prunedDevices: pruned.deletedCount }
  },
}
