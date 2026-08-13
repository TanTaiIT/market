import { Socket } from 'socket.io'

/**
 * Skeleton chat realtime giữa người mua - người bán.
 * TODO: lưu message vào DB (chat module), phát tới phòng theo conversationId.
 *
 * Tên phòng mang organizationId của chính socket, không phải giá trị client gửi lên: đây là
 * chỗ duy nhất chặn được rò rỉ xuyên tenant ở tầng realtime. Client chỉ gửi conversationId,
 * còn nó thuộc org nào là do JWT quyết định, nên đoán id của org khác cũng không vào được
 * phòng của họ mà chỉ tạo ra một phòng rỗng trong org của mình.
 *
 * Còn thiếu (thuộc về chat module, nơi giữ danh sách thành viên hội thoại): kiểm tra người
 * này có nằm trong hội thoại không. Hiện bất kỳ ai **cùng org** vẫn join được nếu đoán trúng id.
 */
const roomOf = (organizationId: string, conversationId: string) =>
  `org:${organizationId}:conversation:${conversationId}`

export function registerChatHandlers(socket: Socket): void {
  const organizationId = socket.data.organizationId as string

  socket.on('chat:join', (conversationId: string) => {
    socket.join(roomOf(organizationId, conversationId))
  })

  socket.on('chat:message', (payload: { conversationId: string; text: string }) => {
    // TODO: persist message, kiểm tra quyền, rồi phát.
    socket.to(roomOf(organizationId, payload.conversationId)).emit('chat:message', {
      from: socket.data.userId,
      text: payload.text,
      at: new Date().toISOString(),
    })
  })
}
