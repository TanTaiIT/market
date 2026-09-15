import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { verifyAccessToken } from '../common/utils/jwt'
import { membershipRepository } from '../features/membership/membership.repository'
import { env } from '../config/env'
import { logger } from '../config/logger'
import { registerChatHandlers } from './chat.socket'
import { orgMembersRoom, setSocketServer, userRoom } from './emit'

let io: SocketServer | null = null

export function initSockets(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
  })
  // `chat.service` phát tin qua đây sau khi lưu — xem ghi chú cắt vòng import trong emit.ts.
  setSocketServer(io)

  // Adapter mặc định là in-memory: tin nhắn chỉ tới được client đang nối vào CHÍNH instance
  // này. Đúng ở quy mô một instance. Chạy nhiều instance thì cần adapter chia sẻ
  // (`@socket.io/redis-adapter` là bản chuẩn) — thêm đúng một dòng `io.adapter(...)` ở đây.

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

    /*
     * Org là TUỲ CHỌN của phiên socket, không còn là điều kiện để bắt tay.
     *
     * Bản trước từ chối kết nối khi không xác định được đúng một org — nghĩa là người chưa vào
     * nhóm nào, và cả người vào từ hai nhóm trở lên (đo trên dữ liệu thật: 20/20 tài khoản),
     * đều không mở nổi socket. Chat realtime chết im lặng với gần như mọi người dùng, trong
     * khi thứ duy nhất còn cần tới org ở tầng này là phòng quản trị `admin:join`.
     *
     * Vẫn đọc membership từ DB chứ không tin `auth.organizationId` client gửi lên: nó chỉ dùng
     * để CHỌN trong số nhóm mình thật sự thuộc về.
     */
    const memberships = await membershipRepository.listActiveByUser(userId)
    const requested = socket.handshake.auth?.organizationId as string | undefined
    const membership = requested
      ? memberships.find((m) => m.organizationId.toString() === requested)
      : memberships.length === 1
        ? memberships[0]
        : undefined

    socket.data.userId = userId
    // Danh sách nhóm để `connection` vào phòng thành viên — handshake đã tải `memberships`
    // cho việc chọn org hoạt động, nên đây chỉ là dùng lại chứ không phải một lượt tra nữa.
    socket.data.orgIds = memberships.map((m) => m.organizationId.toString())
    socket.data.organizationId = membership?.organizationId.toString() ?? null
    next()
  })

  io.on('connection', (socket) => {
    logger.debug('socket connected', { userId: socket.data.userId })

    /*
     * Vào phòng riêng NGAY, không chờ client xin.
     *
     * Đây là thứ cho phép báo 'có tin nhắn mới' khi người dùng đang ở màn khác. Phòng hội
     * thoại thì phải `chat:join` mới vào, mà lúc đang ở bảng tin thì không ai join cả — nên
     * nếu chỉ có phòng hội thoại thì tín hiệu realtime chỉ tới được người ĐÃ nhìn thấy tin.
     *
     * Không có sự kiện `user:join` cho client gọi: danh tính đến từ handshake đã xác thực, cho
     * client tự khai id là mở đường nghe lén hộp thư người khác.
     */
    socket.join(userRoom(socket.data.userId))
    // Thông báo phát chung của nhóm đi vào những phòng này — xem `orgMembersRoom`.
    for (const orgId of (socket.data.orgIds as string[]) ?? []) {
      socket.join(orgMembersRoom(orgId))
    }

    registerChatHandlers(socket)

    socket.on('disconnect', () => {
      logger.debug('socket disconnected', { userId: socket.data.userId })
    })
  })

  return io
}

/** Đóng Socket.IO (graceful shutdown). */
export async function closeSockets(): Promise<void> {
  if (io) {
    await io.close()
    io = null
    setSocketServer(null)
  }
}
