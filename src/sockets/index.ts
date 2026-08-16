import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import { verifyAccessToken } from '../common/utils/jwt'
import { membershipRepository } from '../features/membership/membership.repository'
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
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (!token) return next(new Error('Missing token'))

    let userId: string
    try {
      userId = verifyAccessToken(token).sub
    } catch {
      return next(new Error('Invalid token'))
    }

    // Token không còn mang org, mà socket sống lâu và cần đúng một org để join room. Client
    // gửi kèm `orgSlug`… nhưng ở đây chỉ chấp nhận khi người đó THỰC SỰ là thành viên: đọc
    // membership lúc bắt tay, không tin dữ liệu client gửi lên.
    const memberships = await membershipRepository.listActiveByUser(userId)
    const requested = socket.handshake.auth?.organizationId as string | undefined
    const membership = requested
      ? memberships.find((m) => m.organizationId.toString() === requested)
      : memberships.length === 1
        ? memberships[0]
        : undefined

    if (!membership) return next(new Error('Missing or invalid organization'))

    socket.data.userId = userId
    socket.data.organizationId = membership.organizationId.toString()
    next()
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
