import mongoose from 'mongoose'
import express, { Application, Request, Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { apiReference } from '@scalar/express-api-reference'

import { env } from './config/env'
import { logger } from './config/logger'
import { generateOpenApiDocument } from './config/openapi'
import featureRoutes from './features' // side-effect: đăng ký schema vào OpenAPI registry
import { notFound } from './middlewares/notFound.middleware'
import { requestContext } from './middlewares/requestContext.middleware'
import { resolveTenant } from './middlewares/tenant.middleware'
import { errorConverter, errorHandler } from './middlewares/error.middleware'

/** Ngắn hơn hẳn chu kỳ gọi health của nơi deploy — trả "down" nhanh còn hơn treo. */
const HEALTH_PING_TIMEOUT_MS = 2000

/** Ping Mongo với hạn giờ — xem ghi chú ở route `/health`. */
async function pingDb(): Promise<boolean> {
  const db = mongoose.connection.db
  if (mongoose.connection.readyState !== 1 || !db) return false
  try {
    await Promise.race([
      db.admin().ping(),
      new Promise((_resolve, reject) => {
        // `unref` để một health check đang chờ không giữ process sống lúc shutdown.
        setTimeout(() => reject(new Error('ping timeout')), HEALTH_PING_TIMEOUT_MS).unref()
      }),
    ])
    return true
  } catch (err) {
    logger.error('health: Mongo không phản hồi', { err })
    return false
  }
}

export function createApp(): Application {
  const app = express()

  /*
   * ĐỨNG TRƯỚC MỌI THỨ. Thứ gì chạy trước nó thì log ra không có `requestId` — đúng những
   * dòng đầu tiên cần đến khi một request chết ngay ở cửa (CORS, body quá lớn, JSON hỏng).
   */
  app.use(requestContext)

  // Security & hạ tầng
  app.use(helmet())
  app.use(
    cors({
      origin: env.CORS_ORIGINS, // whitelist domain cụ thể, không để '*'
      credentials: true,
    }),
  )
  app.use(compression())
  // `verify` giữ lại byte gốc cho webhook Cloudinary: chữ ký `X-Cld-Signature` ký trên RAW
  // body, mà parse xong rồi stringify lại không bảo toàn từng byte (thứ tự key, khoảng trắng).
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        ;(req as Request & { rawBody?: Buffer }).rawBody = buf
      },
    }),
  )
  app.use(express.urlencoded({ extended: true }))

  // Access log. Không kéo pino-http/morgan về chỉ để in một dòng mỗi request.
  app.use((req: Request, res: Response, next) => {
    const startedAt = Date.now()
    res.on('finish', () => {
      // Bỏ qua `/health`: nơi deploy gọi nó vài chục giây một lần, và một dòng log rác mỗi
      // lần sẽ nhấn chìm chính những dòng cần đọc.
      if (req.path === '/health') return
      /*
       * `requestId`/`userId` KHÔNG truyền tay vào đây — `logger` tự lấy từ ngữ cảnh.
       * Dòng này chạy trong `res.on(finish)`, vẫn cùng ngữ cảnh async của request, nên
       * `userId` do `authenticate` gắn giữa chuỗi middleware vẫn thấy được.
       */
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
        ms: Date.now() - startedAt,
        status: res.statusCode,
      })
    })
    next()
  })

  /**
   * Health check — kiểm DB THẬT, không chỉ báo "process còn sống".
   *
   * Bản trước trả `ok` vô điều kiện, và đó là kiểu health check tệ nhất: Mongo chết mà vẫn
   * xanh nghĩa là load balancer tiếp tục đẩy traffic vào một instance không phục vụ được gì,
   * còn cơ chế tự restart thì không bao giờ được kích hoạt. Một health check luôn xanh tương
   * đương không có health check, chỉ tốn thêm một đường HTTP.
   *
   * `readyState` là trạng thái mongoose TỰ nghĩ, có thể lệch thực tế, nên ping thật một lượt.
   * Ping có hạn giờ: một Mongo treo (không chết) sẽ làm chính health check treo theo, và lúc
   * đó nơi deploy đọc được đúng con số 0 thông tin.
   */
  app.get('/health', async (_req: Request, res: Response) => {
    const db = await pingDb()
    const status = db ? 'ok' : 'degraded'
    // 503 để nơi deploy hiểu: đừng gửi traffic vào đây. 200 kèm `degraded` là nói một chuyện
    // mà không ai nghe — mọi health check đều chỉ đọc mã trạng thái.
    res.status(db ? 200 : 503).json({
      success: db,
      status,
      db: db ? 'up' : 'down',
      uptime: process.uptime(),
    })
  })

  // API routes. resolveTenant phải đứng trước mọi route nghiệp vụ để scope sống suốt request.
  // Không còn nhánh `/platform-admin` riêng: `master` giờ là một quyền trong `role_grants` của
  // một User bình thường, nên nó đi chung một đường auth với mọi người.
  app.use(env.API_PREFIX, resolveTenant, featureRoutes)

  // OpenAPI (code-first từ Zod) + Scalar API Reference
  const openApiDocument = generateOpenApiDocument()
  app.get('/openapi.json', (_req: Request, res: Response) => res.json(openApiDocument))
  app.use('/docs', apiReference({ spec: { url: '/openapi.json' } }))

  // 404 + error handlers (đặt cuối cùng)
  app.use(notFound)
  app.use(errorConverter)
  app.use(errorHandler)

  return app
}
