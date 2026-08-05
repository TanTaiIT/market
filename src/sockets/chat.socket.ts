import { Server as SocketServer, Socket } from 'socket.io'

/**
 * Skeleton chat realtime giữa người mua - người bán.
 * TODO: lưu message vào DB (chat module), phát tới phòng theo conversationId.
 */
export function registerChatHandlers(_io: SocketServer, socket: Socket): void {
  socket.on('chat:join', (conversationId: string) => {
    socket.join(`conversation:${conversationId}`)
  })

  socket.on('chat:message', (payload: { conversationId: string; text: string }) => {
    // TODO: persist message, kiểm tra quyền, rồi phát.
    socket.to(`conversation:${payload.conversationId}`).emit('chat:message', {
      from: socket.data.userId,
      text: payload.text,
      at: new Date().toISOString(),
    })
  })
}
