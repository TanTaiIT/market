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
 * Phòng của một hội thoại. KHÔNG mang `organizationId` nữa — hội thoại không thuộc org nào
 * (xem `chat.model.ts`), và một tiền tố org sẽ chia đôi cùng một phòng khi hai người ở hai
 * nhóm khác nhau: tin nhắn phát vào phòng của người này thì người kia không bao giờ nghe thấy.
 *
 * Chốt rò rỉ chuyển sang `chat:join`: vào phòng được hay không do `chatService.getById` phán,
 * và nó chỉ trả về hội thoại mà người gọi CÓ TÊN trong `participants`. Đoán trúng id của một
 * hội thoại người khác vẫn không join được.
 */
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`
}

/** Phòng chung của quản trị một trường — dòng "Vừa diễn ra" ở bàn quản trị nghe ở đây. */
export function adminRoom(organizationId: string): string {
  return `org:${organizationId}:admin`
}

export function emitToOrgAdmins(organizationId: string, event: string, payload: unknown): void {
  io?.to(adminRoom(organizationId)).emit(event, payload)
}

/** No-op khi chưa init socket (vd trong test HTTP) — gửi tin nhắn không được phép vì thế mà hỏng. */
export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  io?.to(conversationRoom(conversationId)).emit(event, payload)
}
