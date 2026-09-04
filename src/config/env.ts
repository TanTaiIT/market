import path from 'node:path'
import { z } from 'zod'
import dotenv from 'dotenv'

/**
 * NODE_ENV phải đến từ dòng lệnh (`cross-env` trong package.json) hoặc từ secret manager của
 * nơi deploy, KHÔNG từ file `.env.*`: chính nó quyết định file nào được nạp, nên để file tự
 * khai là lập luận vòng tròn — người gõ lệnh không biết mình đang nối `market-dev` hay
 * `market-pro`. Sai lệch giữa hai nguồn bị chặn ngay bên dưới.
 */
const mode = process.env.NODE_ENV ?? 'development'

/**
 * dotenv KHÔNG ghi đè biến đã tồn tại, nên thứ tự nạp chính là thứ tự ưu tiên:
 * biến thật (shell / secret manager) > `.env.<mode>.local` > `.env.<mode>` > `.env.local` > `.env`.
 * Giữ đúng thứ tự của Vite ở repo web để hai bên không phải nhớ hai luật khác nhau.
 */
for (const file of [`.env.${mode}.local`, `.env.${mode}`, '.env.local', '.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), file) })
}

// Test không chạm DB thật: integration test tự set MONGO_URI của mongodb-memory-server trước khi
// import `src/`, còn unit test chỉ kéo `env` vào gián tiếp qua `openapi.ts`. Không có giá trị giả
// ở đây thì `npm test` trên máy vừa clone (chưa có file `.env*` nào) chết ở `process.exit(1)` —
// và giá trị thật của dev/prod thì tuyệt đối không được là fallback của test.
if (mode === 'test') {
  const testDefaults = {
    MONGO_URI: 'mongodb://127.0.0.1:27017/market-test',
    JWT_SECRET: 'test_secret',
    JWT_REFRESH_SECRET: 'test_refresh_secret',
  }
  for (const [key, value] of Object.entries(testDefaults)) {
    if (!process.env[key]) process.env[key] = value
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  API_PREFIX: z.string().default('/api/v1'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  /**
   * Ép danh sách DNS server cho resolver NỘI BỘ của Node (c-ares), phân tách bằng dấu phẩy.
   * Bỏ trống ở mọi môi trường bình thường — đây là van xả cho một lỗi của máy, không phải cấu hình.
   *
   * Vì sao cần tới nó: `mongodb+srv://` buộc phải tra SRV + TXT, mà `dns.resolveSrv` đi qua
   * c-ares chứ không qua getaddrinfo của OS. Trên vài máy Windows (nhiều adapter ảo
   * WSL/Hyper-V/ICS), c-ares đọc hụt cấu hình DNS của hệ thống rồi rơi về `127.0.0.1` — nơi
   * không có ai trả lời. Hệ quả rất dễ chẩn đoán nhầm: `nslookup` và trình duyệt vẫn chạy
   * (chúng dùng getaddrinfo), chỉ Node là ECONNREFUSED sau ~20ms. Đặt DNS tĩnh trong Windows
   * KHÔNG chữa được, vì c-ares không đọc tới đó.
   */
  DNS_SERVERS: z.string().optional(),

  // Nhịp quét của người duyệt máy (cú pháp human-interval của Agenda: '2 minutes', '30 seconds').
  MACHINE_REVIEW_EVERY: z.string().default('2 minutes'),

  /*
   * Nhịp hạ tin quá hạn xuống `expired`. Một giờ là đủ: hạn tin tính bằng NGÀY, nên trễ tối đa
   * một giờ không ai thấy — mà trên free tier job chỉ chạy khi có traffic đánh thức server
   * (xem `config/agenda.ts`), đặt nhịp dày hơn cũng không làm nó đúng giờ hơn.
   */
  LISTING_EXPIRY_EVERY: z.string().default('1 hour'),

  // Domain gốc để tách subdomain -> Organization.slug (vd 'app.com' => hungvuong.app.com).
  // Bỏ trống ở dev/test: khi đó org hoạt động đến từ header `X-Org-Slug`, hoặc suy ra khi
  // người dùng chỉ thuộc đúng một org.
  APP_BASE_DOMAIN: z.string().optional(),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  // 15 phút, không phải 7 ngày: suspend một Organization phải có hiệu lực trong vài phút,
  // và middleware tenant đã check status live nên token ngắn chỉ còn là lớp thứ hai.
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  /**
   * Tài khoản master — DỮ LIỆU MẶC ĐỊNH, chỉ `scripts/migrate-master.ts` đọc tới.
   *
   * Không có đường runtime nào tạo master: `POST /role-grants` cấm role này và endpoint
   * bootstrap qua HTTP đã bị gỡ. Hệ thống có đúng một master, và nó ra đời cùng database.
   *
   * `optional()` vì server KHÔNG cần hai biến này để chạy — chỉ migration cần. Bắt buộc ở
   * schema là mọi môi trường đã có master từ lâu vẫn phải mang theo mật khẩu master để boot.
   */
  MASTER_EMAIL: z.string().email().optional(),
  MASTER_PASSWORD: z.string().min(6).max(72).optional(),

  // Admin API cho job dọn ảnh mồ côi (upload.cleanup.service.ts). Thiếu bộ ba thì job tự
  // tắt — không phải lỗi cấu hình, chỉ là chưa bật tính năng.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default('ghim'),
  IMAGE_CLEANUP_EVERY: z.string().default('24 hours'),

  AWS_S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  // `logger` import `env` nên chưa tồn tại ở thời điểm này — console là lối duy nhất còn lại.
  console.error('❌ Invalid environment variables:', parsed.error.format())
  process.exit(1)
}

// Một file `.env.*` khai NODE_ENV khác mode đã dùng để chọn file = app đọc config của môi
// trường này nhưng tự nhận là môi trường kia (log level, stack trace trong response, và chốt
// an toàn của seed đều đọc `NODE_ENV`). Fail sớm thay vì chạy với danh tính sai.
if (parsed.data.NODE_ENV !== mode) {
  console.error(
    `❌ NODE_ENV mismatch: file .env* khai "${parsed.data.NODE_ENV}" nhưng mode nạp file là ` +
      `"${mode}". Bỏ NODE_ENV khỏi file .env* — đặt nó ở lệnh chạy hoặc secret manager.`,
  )
  process.exit(1)
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isDev: parsed.data.NODE_ENV === 'development',
  isTest: parsed.data.NODE_ENV === 'test',
}

export type Env = typeof env
