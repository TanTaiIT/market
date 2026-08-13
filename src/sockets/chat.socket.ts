import { Socket } from 'socket.io'
import { chatService } from '../features/chat/chat.service'
import { runWithTenant } from '../common/tenant/tenantContext'
import { organizationRepository } from '../features/organization/organization.repository'
import { logger } from '../config/logger'
import { adminRoom, conversationRoom } from './emit'
import { ORG_ROLES } from '../common/constants'

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

      await runWithTenant({ ownOrgId: org._id, chainOrgIds: [org._id] }, () =>
        chatService.getById(conversationId, { id: userId, organizationId }),
      )

      socket.join(conversationRoom(organizationId, conversationId))
      socket.emit('chat:joined', { conversationId })
    } catch {
      // `getById` ném 404 cho cả "không tồn tại" lẫn "không phải thành viên" — giữ nguyên sự
      // mơ hồ đó ở đây, đừng nói cho client biết hội thoại có tồn tại hay không.
      socket.emit('chat:error', { conversationId, reason: 'not-found' })
    }
  })

  // Dòng "Vừa diễn ra" của bàn quản trị. Role đọc từ JWT chứ không từ giá trị client gửi lên,
  // nên thành viên thường có emit thẳng cũng không vào được phòng.
  socket.on('admin:join', () => {
    const role = socket.data.role as string
    if (role !== ORG_ROLES.OWNER && role !== ORG_ROLES.MODERATOR) {
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
