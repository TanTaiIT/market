import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import { TOKEN_TYPE, verifyAccessToken } from '../common/utils/jwt'
import { duplicateRedis, getRedis } from '../config/redis'
import { env } from '../config/env'
import { logger } from '../config/logger'
import { registerChatHandlers } from './chat.socket'
import { setSocketServer } from './emit'

let io: SocketServer | null = null
let subClient: Redis | null = null

export function initSockets(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
  })
  // `chat.service` phát tin qua đây sau khi lưu — xem ghi chú cắt vòng import trong emit.ts.
  setSocketServer(io)

  // Redis adapter: bắt buộc khi chạy >1 instance để emit tới client ở instance khác.
  // Không có Redis (dev) -> fallback in-memory adapter (chỉ đúng khi 1 instance).
  const pubClient = getRedis()
  if (pubClient) {
    subClient = duplicateRedis(pubClient)
    io.adapter(createAdapter(pubClient, subClient))
    logger.info('✅ Socket.IO Redis adapter enabled (multi-instance ready)')
  } else {
    logger.warn(
      '⏭️  Socket.IO dùng in-memory adapter (không có Redis) - KHÔNG scale nhiều instance',
    )
  }

  // Auth handshake bằng JWT (token gửi qua auth payload của socket.io)
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (!token) return next(new Error('Missing token'))
    try {
      const payload = verifyAccessToken(token)
      // Cùng một secret ký cả token user lẫn platform-admin, nên `type` là thứ duy nhất chặn
      // token bên bán phần mềm mở socket của người dùng cuối — giống hệt `authenticate`.
      if (payload.type !== TOKEN_TYPE.USER) return next(new Error('Invalid token'))

      socket.data.userId = payload.sub
      socket.data.organizationId = payload.organizationId
      socket.data.role = payload.role
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    logger.debug('socket connected', { userId: socket.data.userId })
    registerChatHandlers(socket)

    socket.on('disconnect', () => {
      logger.debug('socket disconnected', { userId: socket.data.userId })
    })
  })

  return io
}

/**
 * Đóng Socket.IO + sub client (graceful shutdown).
 */
export async function closeSockets(): Promise<void> {
  if (io) {
    await io.close()
    io = null
    setSocketServer(null)
  }
  if (subClient) {
    await subClient.quit()
    subClient = null
  }
}
