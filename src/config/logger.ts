import pino from 'pino'
import { env } from './env'

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  base: { service: 'cho-tot-clone-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: !env.isProd
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
})
