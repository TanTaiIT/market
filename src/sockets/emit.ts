import type { Server as SocketServer } from 'socket.io'

/**
 * Giữ tham chiếu tới Socket.IO server, tách khỏi `sockets/index.ts` để cắt vòng import:
 * `sockets/index` → `chat.socket` → `chat.service` → **file này**. Nếu `chat.service` import
 * thẳng `sockets/index` thì vòng khép lại và module nào nạp trước sẽ nhận `undefined`.
 *
 * File này cố tình không import gì trong repo — đó là điều kiện để nó nằm ở đáy vòng.
 */
let io: SocketServer | null = null

export function setSocketServer(next: SocketServer | null): void {
  io = next
}

/**
 * Tên phòng luôn mang `organizationId` của chính socket, không phải giá trị client gửi lên.
 * Đây là chỗ chặn rò rỉ xuyên tenant ở tầng realtime: đoán trúng id hội thoại của trường
 * khác cũng chỉ vào được một phòng rỗng trong trường của mình.
 */
export function conversationRoom(organizationId: string, conversationId: string): string {
  return `org:${organizationId}:conversation:${conversationId}`
}

/** Phòng chung của quản trị một trường — dòng "Vừa diễn ra" ở bàn quản trị nghe ở đây. */
export function adminRoom(organizationId: string): string {
  return `org:${organizationId}:admin`
}

export function emitToOrgAdmins(organizationId: string, event: string, payload: unknown): void {
  io?.to(adminRoom(organizationId)).emit(event, payload)
}

/** No-op khi chưa init socket (vd trong test HTTP) — gửi tin nhắn không được phép vì thế mà hỏng. */
export function emitToConversation(
  organizationId: string,
  conversationId: string,
  event: string,
  payload: unknown,
): void {
  io?.to(conversationRoom(organizationId, conversationId)).emit(event, payload)
}
