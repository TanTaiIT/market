import { Socket } from 'socket.io'
import { chatService } from '../features/chat/chat.service'
import { logger } from '../config/logger'
import { adminRoom, conversationRoom } from './emit'
import { canModerateAnyInOrg } from '../common/authz/policy'
import { roleGrantService } from '../features/role-grant/role-grant.service'

/**
 * Socket chỉ **giao hàng**, không ghi. Client gửi tin nhắn bằng `POST /chats/:id/messages`;
 * service lưu xong thì phát `chat:message` vào phòng. Nhờ vậy chỉ có một đường ghi, một chỗ
 * kiểm tra quyền, và tin nhắn gửi lúc socket rớt không mất trắng.
 *
 * `chat:join` phải kiểm tra thành viên chứ không tin id client gửi lên — thiếu bước đó thì
 * bất kỳ ai trong org cũng nghe lén được mọi hội thoại chỉ bằng cách đoán id.
 */
export function registerChatHandlers(socket: Socket): void {
  const userId = socket.data.userId as string
  /** `null` khi người này chưa thuộc nhóm nào — chỉ `admin:join` phía dưới còn cần tới nó. */
  const organizationId = socket.data.organizationId as string | null

  socket.on('chat:join', async (conversationId: unknown) => {
    if (typeof conversationId !== 'string' || !conversationId) return

    try {
      /*
       * Không còn `runWithTenant`: `Conversation` đã bỏ `tenantPlugin`, nên truy vấn ở đây
       * không cần scope nào để chạy. Chốt quyền là `getById` → `requireMembership`, và nó hỏi
       * đúng một câu — người này có tên trong `participants` không.
       *
       * Bỏ luôn lượt tra org đang hoạt động: hội thoại về một tin công khai không thuộc org
       * nào, mà bản cũ lại từ chối join khi không dựng được scope org.
       */
      await chatService.getById(conversationId, { id: userId })

      socket.join(conversationRoom(conversationId))
      socket.emit('chat:joined', { conversationId })
    } catch {
      // `getById` ném 404 cho cả "không tồn tại" lẫn "không phải thành viên" — giữ nguyên sự
      // mơ hồ đó ở đây, đừng nói cho client biết hội thoại có tồn tại hay không.
      socket.emit('chat:error', { conversationId, reason: 'not-found' })
    }
  })

  // Dòng "Vừa diễn ra" của bàn quản trị. Quyền đọc từ `role_grants` ngay lúc join chứ không
  // từ token: token không còn mang role, và đọc lúc join nghĩa là thu hồi quyền có hiệu lực
  // ở lần join kế tiếp thay vì phải chờ token hết hạn.
  socket.on('admin:join', async () => {
    // Đây là chỗ DUY NHẤT còn cần org ở tầng socket. Không có org trong phiên thì không có
    // phòng quản trị nào để vào — trả `forbidden` như mọi lượt thiếu quyền khác.
    if (!organizationId) return socket.emit('chat:error', { reason: 'forbidden' })

    const grants = await roleGrantService.grantsOf(userId)
    if (!canModerateAnyInOrg(grants, organizationId)) {
      return socket.emit('chat:error', { reason: 'forbidden' })
    }
    socket.join(adminRoom(organizationId))
  })

  socket.on('chat:leave', (conversationId: unknown) => {
    if (typeof conversationId === 'string' && conversationId) {
      socket.leave(conversationRoom(conversationId))
    }
  })

  socket.on('disconnect', () => {
    logger.debug('socket rời hội thoại', { userId })
  })
}
