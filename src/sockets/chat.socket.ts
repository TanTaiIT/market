import { Socket } from 'socket.io'
import { chatService } from '../features/chat/chat.service'
import { runWithTenant } from '../common/tenant/tenantContext'
import { organizationRepository } from '../features/organization/organization.repository'
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
  const organizationId = socket.data.organizationId as string

  socket.on('chat:join', async (conversationId: unknown) => {
    if (typeof conversationId !== 'string' || !conversationId) return

    try {
      // Socket sống ngoài chu kỳ request nên không có sẵn tenant scope — phải tự dựng lại,
      // đúng org trong JWT của chính socket này.
      const org = await organizationRepository.findActiveById(organizationId)
      if (!org) return socket.emit('chat:error', { conversationId, reason: 'org-inactive' })

      await runWithTenant(
        { ownOrgId: org._id, readableOrgIds: [org._id], publicAxis: { mode: 'approved' } },
        () => chatService.getById(conversationId, { id: userId, organizationId }),
      )

      socket.join(conversationRoom(organizationId, conversationId))
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
    const grants = await roleGrantService.grantsOf(userId)
    if (!canModerateAnyInOrg(grants, organizationId)) {
      return socket.emit('chat:error', { reason: 'forbidden' })
    }
    socket.join(adminRoom(organizationId))
  })

  socket.on('chat:leave', (conversationId: unknown) => {
    if (typeof conversationId === 'string' && conversationId) {
      socket.leave(conversationRoom(organizationId, conversationId))
    }
  })

  socket.on('disconnect', () => {
    logger.debug('socket rời hội thoại', { userId })
  })
}
