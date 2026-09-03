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
import { resolveTenant } from './middlewares/tenant.middleware'
import { errorConverter, errorHandler } from './middlewares/error.middleware'

export function createApp(): Application {
  const app = express()

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
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
        ms: Date.now() - startedAt,
      })
    })
    next()
  })

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ success: true, status: 'ok', uptime: process.uptime() })
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
