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
    logger.info('✅ MongoDB connected')
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
