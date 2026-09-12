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

/**
 * Phòng riêng của MỘT người dùng — mọi thiết bị họ đang mở đều nằm trong đó.
 *
 * Khác `conversationRoom` ở chỗ căn bản: phòng hội thoại chỉ nhận người đã `chat:join`, tức
 * chỉ khi họ ĐANG MỞ đúng màn chat đó. Vì vậy nó không bao giờ báo được "có tin nhắn mới" cho
 * người đang ở bảng tin — mà đó mới là lúc cần báo.
 *
 * Vào phòng này ngay lúc bắt tay (`sockets/index.ts`), không cần client xin: danh tính đã được
 * xác thực ở handshake, nên không có gì để client tự khai và cũng không có gì để đoán trúng.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`
}

/** Báo cho một người ở MỌI thiết bị họ đang mở. No-op khi chưa init socket (vd test HTTP). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload)
}

/**
 * Phòng của THÀNH VIÊN một nhóm — cho thông báo phát chung (`userId: null`).
 *
 * Khác `adminRoom` ở đối tượng: phòng kia chỉ có quản trị và nghe dòng hoạt động của bàn duyệt,
 * phòng này có mọi thành viên và nghe thông báo của nhóm.
 *
 * Vào phòng ngay lúc bắt tay, theo danh sách `memberships` mà handshake VỐN ĐÃ tải để chọn org
 * hoạt động — nên không tốn thêm truy vấn nào, ở cả lúc kết nối lẫn lúc phát. Cách còn lại là
 * tra thành viên mỗi lần có thông báo rồi gọi `emitToUser` từng người: đúng nhưng đắt hơn, và
 * đắt ở đúng đường nóng (mỗi tin đăng mới là một lượt).
 *
 * Hệ quả cần biết: vào nhóm mới giữa phiên thì phải nối lại socket mới nghe được — cùng giới
 * hạn với `admin:join`, vốn cũng đọc quyền một lần lúc join.
 */
export function orgMembersRoom(organizationId: string): string {
  return `org:${organizationId}:members`
}

/**
 * Báo cho mọi thành viên của một nhóm.
 *
 * `exceptUserId` không phải tiện nghi: người vừa đăng tin cũng là thành viên, nên thiếu nó thì
 * chuông của chính họ rung vì tin của chính họ. Ở tầng đọc, `paginateInbox` đã loại họ bằng
 * `actorId != recipient` — nên nếu vẫn phát cho họ thì badge không đổi mà chuông vẫn kêu, tức
 * hai tầng nói hai chuyện khác nhau.
 */
export function emitToOrgMembers(
  organizationId: string,
  event: string,
  payload: unknown,
  opts: { exceptUserId?: string } = {},
): void {
  const room = io?.to(orgMembersRoom(organizationId))
  if (!room) return
  const target = opts.exceptUserId ? room.except(userRoom(opts.exceptUserId)) : room
  target.emit(event, payload)
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
