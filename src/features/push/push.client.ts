import { env } from '../../config/env'
import type { ExpoMessage } from './push.policy'

/**
 * Client MỎNG cho Expo Push Service, viết tay bằng `fetch` của Node 20.
 *
 * Không dùng `expo-server-sdk`: bản hiện hành chỉ phát hành ESM và đòi Node ≥ 22.12, còn backend
 * này là CommonJS trên Node 20 (engines, Dockerfile, CI). API chỉ có hai endpoint — tự viết
 * rẻ hơn ghim một bản SDK cũ hay đổi cả hệ module. Việc chia lô 100 tin nằm ở dispatcher.
 *
 * KHÔNG ném: mọi thất bại vận chuyển trả về `{ ok: false }` để dispatcher quyết retry theo
 * dòng outbox, thay vì một exception làm rơi cả lô.
 */

const SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const TIMEOUT_MS = 10_000

export type ExpoTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } }

export type ExpoReceipt =
  { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } }

export type TransportResult<T> = { ok: true; value: T } | { ok: false; message: string }

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (env.EXPO_ACCESS_TOKEN) h.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`
  return h
}

async function post<T>(url: string, body: unknown): Promise<TransportResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as {
      data?: T
      errors?: { code?: string; message?: string }[]
    } | null
    if (!res.ok || !json || json.data === undefined) {
      const reason = json?.errors?.map((e) => e.code ?? e.message).join(', ')
      return { ok: false, message: `HTTP ${res.status}${reason ? `: ${reason}` : ''}` }
    }
    return { ok: true, value: json.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export const expoPushClient = {
  /** Một request, tối đa 100 tin; ticket trả về đúng thứ tự tin gửi đi. */
  send(messages: ExpoMessage[]): Promise<TransportResult<ExpoTicket[]>> {
    return post<ExpoTicket[]>(SEND_URL, messages)
  },

  receipts(ids: string[]): Promise<TransportResult<Record<string, ExpoReceipt>>> {
    return post<Record<string, ExpoReceipt>>(RECEIPTS_URL, { ids })
  },
}
