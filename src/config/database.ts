import dns from 'node:dns'
import mongoose from 'mongoose'
import { env } from './env'
import { logger } from './logger'

mongoose.set('strictQuery', true)

/**
 * Bơm resolver cho c-ares TRƯỚC lượt tra SRV đầu tiên — xem `DNS_SERVERS` trong `env.ts` để
 * biết lỗi máy nào cần tới nó.
 *
 * Nằm ở tầng module, không nằm trong `connectDB`: `dns.setServers` là trạng thái toàn tiến
 * trình, và mọi thứ khác dùng c-ares (Redis, S3, webhook) cũng hỏng vì đúng nguyên nhân đó —
 * đặt trong hàm connect là chỉ chữa được một chỗ.
 */
function applyDnsOverride(): void {
  const servers = (env.DNS_SERVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (servers.length === 0) return

  try {
    dns.setServers(servers)
    logger.warn('DNS resolver overridden by DNS_SERVERS', { servers })
  } catch (err) {
    // Địa chỉ sai định dạng thì `setServers` NÉM — và ném ở tầng module là app không boot nổi
    // với một stack trace không nói gì về nguyên nhân. Cảnh báo rồi đi tiếp: mặc định của hệ
    // thống vẫn là hành vi đúng ở mọi máy bình thường.
    logger.error('DNS_SERVERS không hợp lệ — bỏ qua, dùng resolver mặc định', { err, servers })
  }
}

applyDnsOverride()

/**
 * 15s thay cho 5s cũ: 5s không đủ dư cho một lần bắt tay TLS chậm tới Atlas, mà khi hết giờ
 * thì Mongoose ném đúng câu "IP isn't whitelisted" khiến người đọc đi sửa nhầm chỗ.
 */
const SERVER_SELECTION_TIMEOUT_MS = 15_000

const IS_ATLAS = env.MONGO_URI.startsWith('mongodb+srv://')

/**
 * Lỗi này KHÔNG phải lỗi mạng tới Atlas — chưa có gói nào ra khỏi máy. Nó là resolver nội bộ
 * của Node không tra được SRV, và nó đội lốt lỗi kết nối rất giống nhau nên rất tốn thời gian.
 *
 * Dấu hiệu nhận: message mang `querySrv`/`queryTxt` kèm `ECONNREFUSED`/`ETIMEOUT`, và nó rơi
 * sau vài chục ms thay vì hết `serverSelectionTimeoutMS`.
 */
function dnsHint(err: unknown): { hint: string } | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!/query(Srv|Txt)/i.test(message)) return null

  return {
    hint:
      'Resolver nội bộ của Node (c-ares) không tra được SRV — KHÔNG phải lỗi whitelist Atlas. ' +
      `Đang dùng DNS: ${dns.getServers().join(', ')}. ` +
      'Nếu thấy 127.0.0.1 thì c-ares đã đọc hụt cấu hình DNS của Windows (thường do adapter ảo ' +
      'WSL/Hyper-V/ICS); đặt DNS tĩnh trong Windows KHÔNG chữa được. Đặt DNS_SERVERS=1.1.1.1,8.8.8.8 ' +
      'trong .env của môi trường đang chạy.',
  }
}

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
      // DNS đứng TRƯỚC nhánh whitelist: `querySrv` hỏng thì chưa có gói nào ra tới Atlas, nên
      // gợi ý whitelist ở ca này chỉ đẩy người đọc đi sửa nhầm chỗ — đúng thứ khối comment
      // trên cảnh báo. Nhận ra bằng `resolveSrv` thất bại, không bằng thời gian.
      ...dnsHint(err),
      ...(timedOut &&
        IS_ATLAS &&
        !dnsHint(err) && {
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
