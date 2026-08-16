import mongoose from 'mongoose'
import { env } from './env'
import { logger } from './logger'

mongoose.set('strictQuery', true)

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 5000,
    })
    // Log TÊN DATABASE, không phải "connected" suông: dev và production dùng chung một cluster
    // và chỉ khác nhau ở tên db, nên đây là chỗ duy nhất xác nhận được mình đang nối đúng chỗ.
    logger.info('✅ MongoDB connected', {
      db: mongoose.connection.name,
      nodeEnv: env.NODE_ENV,
    })
  } catch (err) {
    logger.error('❌ MongoDB connection failed', { err })
    process.exit(1)
  }

  mongoose.connection.on('disconnected', () => logger.warn('⚠️  MongoDB disconnected'))
  mongoose.connection.on('error', (err) => logger.error('MongoDB error', { err }))
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close()
  logger.info('MongoDB connection closed')
}
