import mongoose from 'mongoose'
import { env } from './env'
import { logger } from './logger'

mongoose.set('strictQuery', true)

/**
 * 15s thay cho 5s cũ: 5s không đủ dư cho một lần bắt tay TLS chậm tới Atlas, mà khi hết giờ
 * thì Mongoose ném đúng câu "IP isn't whitelisted" khiến người đọc đi sửa nhầm chỗ.
 */
const SERVER_SELECTION_TIMEOUT_MS = 15_000

const IS_ATLAS = env.MONGO_URI.startsWith('mongodb+srv://')

export async function connectDB(): Promise<void> {
  const startedAt = Date.now()
  try {
    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      // Mongoose mặc định BẬT: mỗi lần boot là một lượt `createIndex` cho mọi schema. Ở dev thì
      // tiện (sửa index xong restart là có), ở production thì đó là việc nặng chạy đúng lúc
      // deploy. `scripts/migrate-v2.ts` vốn đã giả định nó tắt ở production — nay giả định đó
      // thành sự thật, và `syncIndexes` trong migration mới là nơi duy nhất tạo index thật.
      autoIndex: !env.isProd,
    })
    // Log TÊN DATABASE, không phải "connected" suông: dev và production dùng chung một cluster
    // và chỉ khác nhau ở tên db, nên đây là chỗ duy nhất xác nhận được mình đang nối đúng chỗ.
    logger.info('✅ MongoDB connected', {
      db: mongoose.connection.name,
      nodeEnv: env.NODE_ENV,
      ms: Date.now() - startedAt,
    })
  } catch (err) {
    const elapsed = Date.now() - startedAt
    const timedOut = elapsed >= SERVER_SELECTION_TIMEOUT_MS

    // Mongoose in nguyên văn "IP isn't whitelisted" cho MỌI lỗi chọn server, nên câu đó không
    // phải chẩn đoán. Cách tách nhanh: gói tới cổng 27017 bị DROP (hết giờ, không có RST) trên
    // CẢ BA shard = tầng mạng chặn — whitelist Atlas hoặc firewall. Nối được nhưng lỗi ngay =
    // sai mật khẩu/tên db. Cùng máy lúc được lúc không thường là IP ra ngoài đang đổi (VPN).
    logger.error('❌ MongoDB connection failed', {
      err,
      ms: elapsed,
      timedOut,
      ...(timedOut &&
        IS_ATLAS && {
          hint:
            `Hết ${SERVER_SELECTION_TIMEOUT_MS}ms mà không chọn được server nào. ` +
            'Kiểm tra IP ra ngoài hiện tại có nằm trong Network Access của Atlas không — ' +
            'chạy sau VPN/WARP thì IP đó đổi liên tục nên whitelist cố định sẽ lúc được lúc không.',
        }),
    })
    process.exit(1)
  }

  mongoose.connection.on('disconnected', () => logger.warn('⚠️  MongoDB disconnected'))
  mongoose.connection.on('error', (err) => logger.error('MongoDB error', { err }))
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close()
  logger.info('MongoDB connection closed')
}
