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
  app.use(express.json({ limit: '1mb' }))
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

  // API routes
  app.use(env.API_PREFIX, featureRoutes)

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
