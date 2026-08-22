import http from 'http'
import { createApp } from './app'
import { connectDB, disconnectDB } from './config/database'
import { startAgenda, stopAgenda } from './config/agenda'
import { initSockets, closeSockets } from './sockets'
import { env } from './config/env'
import { logger } from './config/logger'

async function bootstrap() {
  await connectDB()
  await startAgenda()

  const app = createApp()
  const httpServer = http.createServer(app)

  initSockets(httpServer)

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 Server listening on http://localhost:${env.PORT}`)
    logger.info(`📚 API docs at http://localhost:${env.PORT}/docs`)
  })

  // Graceful shutdown: ngừng nhận request -> đóng socket -> đóng Mongo
  const closeHttp = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()))
    })

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received, shutting down...`)

    // Force exit nếu treo quá 10s
    const forceTimer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit')
      process.exit(1)
    }, 10000)
    forceTimer.unref()

    try {
      await closeHttp()
      await closeSockets()
      await stopAgenda()
      await disconnectDB()
      logger.info('Graceful shutdown complete')
      clearTimeout(forceTimer)
      process.exit(0)
    } catch (err) {
      logger.error('Graceful shutdown failed', { err })
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // Handler này chặn Node crash mặc định -> bắt buộc phải log, không thì lỗi biến mất hoàn toàn.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason })
  })
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { err })
  process.exit(1)
})
