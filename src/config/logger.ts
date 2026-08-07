import winston from 'winston'
import { env } from './env'
import { removeEmoji } from '../common/utils/removeEmoji'

// message/stack của Error là non-enumerable -> JSON.stringify trả "{}" và nuốt sạch lỗi.
function serializeMeta(meta: Record<string, unknown>): string {
  if (!Object.keys(meta).length) return ''
  const json = JSON.stringify(meta, (_key, value) =>
    value instanceof Error ? { message: value.message, stack: value.stack } : value,
  )
  return ` ${json}`
}

const { combine, timestamp, printf } = winston.format

const consoleFormat = printf((info) => {
  const { level, message, timestamp: ts, ...meta } = info
  delete meta.service // đã có trong defaultMeta, in lại mỗi dòng chỉ tổ nhiễu
  return `${ts} ${level}: ${removeEmoji(message)}${serializeMeta(meta)}`
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
