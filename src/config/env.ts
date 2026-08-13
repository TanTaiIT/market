import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  API_PREFIX: z.string().default('/api/v1'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  // Domain gốc để tách subdomain -> Organization.slug (vd 'app.com' => hungvuong.app.com).
  // Bỏ trống ở dev/test: khi đó org lấy từ `orgSlug` trong body login hoặc từ JWT.
  APP_BASE_DOMAIN: z.string().optional(),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  // 15 phút, không phải 7 ngày: suspend một Organization phải có hiệu lực trong vài phút,
  // và middleware tenant đã check status live nên token ngắn chỉ còn là lớp thứ hai.
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  REDIS_URL: z.string().optional(),

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

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isDev: parsed.data.NODE_ENV === 'development',
  isTest: parsed.data.NODE_ENV === 'test',
}

export type Env = typeof env
