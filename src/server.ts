import http from 'http'
import { createApp } from './app'
import { connectDB, disconnectDB } from './config/database'
import { initSockets, closeSockets } from './sockets'
import { initJobs, shutdownJobs } from './jobs'
import { closeRedis } from './config/redis'
import { env } from './config/env'
import { logger } from './config/logger'

async function bootstrap() {
  await connectDB()

  const app = createApp()
  const httpServer = http.createServer(app)

  initSockets(httpServer)
  await initJobs()

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 Server listening on http://localhost:${env.PORT}`)
    logger.info(`📚 API docs at http://localhost:${env.PORT}/docs`)
  })

  // Graceful shutdown: ngừng nhận request -> đóng socket -> drain jobs -> đóng Mongo -> đóng Redis
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
      await shutdownJobs()
      await disconnectDB()
      await closeRedis()
      logger.info('Graceful shutdown complete')
      clearTimeout(forceTimer)
      process.exit(0)
    } catch (err) {
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
  })
}

bootstrap().catch((err) => {
  process.exit(1)
})
