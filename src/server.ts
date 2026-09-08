import http from 'http'
import { createApp } from './app'
import { connectDB, disconnectDB } from './config/database'
import { startAgenda, stopAgenda } from './config/agenda'
import { flushSentry, initSentry } from './config/sentry'
import { initSockets, closeSockets } from './sockets'
import { env } from './config/env'
import { logger } from './config/logger'

async function bootstrap() {
  // TRƯỚC `connectDB`: lỗi ngay lúc nối DB cũng là lỗi cần báo, mà đó lại là loại lỗi dễ mất
  // nhất — process chết trước khi có ai kịp đọc log.
  initSentry()

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
      // Sentry gửi theo lô — không flush thì lỗi làm sập server, đúng loại cần nhất, lại là
      // lỗi duy nhất không bao giờ tới nơi.
      await flushSentry()
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

  /*
   * `uncaughtException` KHÔNG được bỏ qua rồi chạy tiếp: tới đây process đã ở trạng thái không
   * xác định (một callback nào đó đã chết giữa chừng). Log, flush, rồi để nó chết cho nơi
   * deploy khởi động lại — đó là hành vi đúng, khác hẳn với việc giả vờ mọi thứ vẫn ổn.
   */
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — thoát để được khởi động lại', { err })
    void flushSentry().finally(() => process.exit(1))
  })
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { err })
  process.exit(1)
})
