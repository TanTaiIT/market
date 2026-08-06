import winston from 'winston'
import { env } from './env'

// Remove emoji but keep normal Unicode characters (Vietnamese diacritics allowed)
function removeEmoji(input: unknown) {
  return String(input ?? '').replace(/\p{Emoji}/gu, '')
}

const { combine, timestamp, printf } = winston.format

const consoleFormat = printf(({ level, message, timestamp: ts }) => {
  const cleaned = typeof message === 'string' ? removeEmoji(message) : message
  return `${ts} ${level}: ${cleaned}`
})

export const logger = winston.createLogger({
  level: env.isProd ? 'info' : 'debug',
  defaultMeta: { service: 'cho-tot-clone-api' },
  transports: [
    new winston.transports.Console({
      format: combine(timestamp({ format: 'HH:mm:ss' }), consoleFormat),
      stderrLevels: ['error'],
    }),
  ],
})
